// Orchestrator extension: `delegate_task` lets a conversation spawn, fork, steer, wait on, list and stop
// parallel subagent conversations. Children are ownerless durable conversations, so they survive the
// spawning tool call and the parent's abort. Each parent records its own children in a conversation document,
// so list/wait/steer/stop only ever touch that parent's children. Replay safety: spawn is keyed by the tool
// call's task id (a rerun after a crash finds the child it already made) and every message has a deterministic requestId.
import { Type } from "@earendil-works/pi-ai";
import { configure, defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

const MSG = "delegate.msg"; // { requestId } per message sent to a child
const NOTE = "delegate.child"; // marker entry written into every child: { task, parent, forkedFrom? }

type ChildRow = { id: number; spawnKey: string; task: string };
/** The children this conversation spawned. A fork starts with none of its parent's children. */
const Children = defineDoc<{ children: ChildRow[] }>({
  kind: "luna.delegate.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: [] }),
});

const parameters = Type.Object({
  action: Type.Union(
    [Type.Literal("spawn"), Type.Literal("steer"), Type.Literal("wait"), Type.Literal("list"), Type.Literal("stop")],
    { description: "spawn: start a child; steer: message a child; wait: gather answers; list: show children; stop: abort a child" },
  ),
  task: Type.Optional(Type.String({ description: "spawn/steer: the instruction for the child" })),
  fork: Type.Optional(
    Type.Boolean({ description: "spawn: child starts as a zero-copy fork of this conversation's history instead of a blank slate" }),
  ),
  forkAt: Type.Optional(Type.Number({ description: "spawn+fork: entry id to fork at (default: latest settled entry)" })),
  ids: Type.Optional(Type.Array(Type.Number(), { description: "steer/wait/stop: child conversation ids (wait: default all of yours)" })),
  timeoutSec: Type.Optional(Type.Number({ description: "wait: max seconds to wait (default 120, max 1800)" })),
});

type ChildReport = { id: number; state: "running" | "done" | "unanswered" | "idle"; answer?: string };

export const Delegate: Extension = defineExtension({
  name: "delegate",
  tools: [
    defineTool({
      name: "delegate_task",
      description:
        "Delegate work to parallel subagent conversations. spawn (optionally fork=true to inherit this conversation's history) returns a child id; " +
        "spawn several, keep working, then wait to gather their answers. steer redirects a running child; stop aborts one; list shows yours.",
      parameters,
      replay: "safe",
      execute: async (args, api, context) => {
        const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
        const parent = await api.agent(context);
        // Children cannot delegate further; they copy the parent's model, thinking level and working directory.
        const childAgent = {
          model: parent.model, thinkingLevel: parent.thinkingLevel, extensions: { remove: [Delegate] },
          ...(parent.cwd ? { cwd: parent.cwd } : {}),
        } as never;

        const mine = (): Promise<ChildRow[]> =>
          // Copy to plain objects inside the commit: draft proxies are unusable once it settles.
          api.commit(async (tx) => (await tx.doc(Children, api.conversationId)).children.map((c) => ({ id: c.id, spawnKey: c.spawnKey, task: c.task })), context);

        // One child's state: every message we sent is logged as a `delegate.msg` entry; a child is done once all
        // those submissions settled, and its answer is the latest one's answer entry.
        const report = (id: number): Promise<ChildReport> =>
          api.commit(async (tx) => {
            const page = await tx.scanEntries({ conversationId: id as never, order: "ascending" }, 500);
            const reqs = [...new Set(page.items.filter((e) => e.kind === MSG).map((e) => (e.data as { requestId: string }).requestId))];
            let state: ChildReport["state"] = reqs.length ? "done" : "idle";
            let answer: string | undefined;
            for (const r of reqs) {
              const sub = await tx.submissionByRequest(id as never, r);
              if (!sub || sub.status === "queued" || sub.status === "placed") state = "running";
              else if (sub.status === "unanswered") { state = "unanswered"; answer = `unanswered: ${sub.reason}`; }
              else if (sub.type === "input" && sub.status === "done") {
                const e = await tx.entry(sub.answer);
                answer = (e?.model ?? [])
                  .flatMap((m) => (m.role === "assistant" ? m.content : []))
                  .flatMap((c) => (c.type === "text" ? [c.text] : []))
                  .join("\n");
              }
            }
            return { id, state, answer };
          }, context);

        // Idempotent: a rerun with the same requestId neither logs the message twice nor submits it twice.
        const submitTo = async (id: number, task: string, requestId: string, whenBusy: "steer" | "followUp") => {
          const h = await api.conversation(id as never, context);
          if (!h) return false;
          await api.commit(async (tx) => {
            const seen = (await tx.scanEntries({ conversationId: id as never, order: "ascending" }, 500)).items
              .some((e) => e.kind === MSG && (e.data as { requestId: string }).requestId === requestId);
            if (!seen) await tx.appendEntry(id as never, { kind: MSG, data: { requestId } });
          }, context);
          await h.submit({ type: "input", content: task, requestId, whenBusy }, context);
          return true;
        };

        // Reject ids this conversation did not spawn: a parent must not drive another parent's children.
        const owned = async (ids: number[]) => {
          const known = new Set((await mine()).map((c) => c.id));
          return { ok: ids.filter((i) => known.has(i)), foreign: ids.filter((i) => !known.has(i)) };
        };
        const foreignNote = (f: number[]) => (f.length ? ` (not your children: ${f.join(", ")})` : "");

        switch (args.action) {
          case "spawn": {
            if (!args.task) return text("spawn needs `task`", true);
            const task = args.task;
            const spawnKey = String(api.taskId);
            const { id, reused } = await api.commit(async (tx) => {
              const doc = await tx.doc(Children, api.conversationId);
              const prior = doc.children.find((c) => c.spawnKey === spawnKey);
              if (prior) return { id: prior.id, reused: true };
              let childId: number;
              if (args.fork) {
                let at = args.forkAt as never;
                if (!at) {
                  // Latest entry that is not an assistant message: forking mid-tool-round would leave a dangling call.
                  const page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 200);
                  at = page.items.find((e) => e.kind !== "pi.assistant")?.id as never;
                }
                if (!at) throw new Error("nothing to fork yet; use fork=false");
                const f = await tx.forkConversation(api.conversationId, at, { ownership: { kind: "ownerless" } });
                await configure(tx, f.id, childAgent);
                await tx.appendEntry(f.id, { kind: NOTE, data: { task, parent: api.conversationId as number, forkedFrom: api.conversationId as number } });
                childId = f.id as number;
              } else {
                const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
                await configure(tx, c.id, childAgent);
                await tx.appendEntry(c.id, { kind: NOTE, data: { task, parent: api.conversationId as number } });
                childId = c.id as number;
              }
              doc.children.push({ id: childId, spawnKey, task: task.slice(0, 200) });
              return { id: childId, reused: false };
            }, context);
            await api.details({ conversationId: id }, context);
            await submitTo(id, task, `delegate:${id}:0`, "followUp");
            return text(`spawned child ${id}${args.fork ? " (forked)" : ""}${reused ? " (resumed after restart)" : ""}`);
          }
          case "steer": {
            if (!args.task || !args.ids?.length) return text("steer needs `task` and `ids`", true);
            const { ok, foreign } = await owned(args.ids);
            for (const id of ok) await submitTo(id, args.task, `delegate:${id}:steer:${api.taskId}`, "steer");
            return text(`steered ${ok.length}/${args.ids.length}: ${ok.join(", ")}${foreignNote(foreign)}`, ok.length === 0);
          }
          case "stop": {
            const { ok, foreign } = await owned(args.ids ?? []);
            for (const id of ok) await (await api.conversation(id as never, context))?.abort(context);
            return text(`stopped ${ok.join(", ") || "none"}${foreignNote(foreign)}`);
          }
          case "list": {
            const kids = await mine();
            const rows = await Promise.all(kids.map(async (k) => ({ ...(await report(k.id)), task: k.task })));
            return text(rows.map((r) => `${r.id}: ${r.state} - ${r.task.slice(0, 80)}`).join("\n") || "no children");
          }
          case "wait": {
            const { ok: ids, foreign } = args.ids?.length ? await owned(args.ids) : { ok: (await mine()).map((c) => c.id), foreign: [] as number[] };
            if (!ids.length) return text(foreign.length ? `not your children: ${foreign.join(", ")}` : "no children", foreign.length > 0);
            const ms = Math.min(Math.max(args.timeoutSec ?? 120, 1), 1800) * 1000;
            const deadline = Date.now() + ms;
            while (Date.now() < deadline && !context.abortSignal?.aborted) {
              const now = await Promise.all(ids.map(report));
              if (now.every((r) => r.state !== "running")) break;
              await new Promise((r) => setTimeout(r, 250));
            }
            const rows = await Promise.all(ids.map(report));
            return text(rows.map((r) => `[${r.id}] ${r.state}${r.answer ? `\n${r.answer}` : ""}`).join("\n\n") + foreignNote(foreign));
          }
        }
      },
    }),
  ],
});
