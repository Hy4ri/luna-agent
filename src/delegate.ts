// Orchestrator extension: `delegate_task` lets a conversation spawn, fork, steer, wait on, list and stop
// parallel subagent conversations. Children are ownerless durable conversations, so they survive the
// spawning tool call and the parent's abort; every message uses a requestId so reruns never double-send.
import { Type } from "@earendil-works/pi-ai";
import { configure, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

const MSG = "delegate.msg"; // { requestId } per message sent to a child
const NOTE = "delegate.child"; // marker entry written into every child: { task, forkedFrom? }

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
  ids: Type.Optional(Type.Array(Type.Number(), { description: "steer/wait/stop: child conversation ids (wait: default all)" })),
  timeoutSec: Type.Optional(Type.Number({ description: "wait: max seconds to wait (default 120)" })),
});

type ChildReport = { id: number; state: "running" | "done" | "unanswered" | "idle"; answer?: string };

export const Delegate: Extension = defineExtension({
  name: "delegate",
  tools: [
    defineTool({
      name: "delegate_task",
      description:
        "Delegate work to parallel subagent conversations. spawn (optionally fork=true to inherit this conversation's history) returns a child id; " +
        "spawn several, keep working, then wait to gather their answers. steer redirects a running child; stop aborts one; list shows all.",
      parameters,
      replay: "safe",
      execute: async (args, api, context) => {
        const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
        const parent = await api.agent(context);
        // Children cannot delegate further; blank-slate children copy the parent's model and settings.
        const childAgent = { model: parent.model, thinkingLevel: parent.thinkingLevel, extensions: { remove: [Delegate] } } as never;

        // One child's state: every message we sent is logged as a `delegate.msg` entry; a child is done once all
        // those submissions settled, and its answer is the latest one's answer entry.
        const report = (id: number): Promise<ChildReport> =>
          api.commit(async (tx) => {
            const page = await tx.scanEntries({ conversationId: id as never, order: "ascending" }, 500);
            const reqs = page.items.filter((e) => e.kind === MSG).map((e) => (e.data as { requestId: string }).requestId);
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

        const known = (): Promise<number[]> =>
          api.commit(async (tx) => {
            const out: number[] = [];
            const page = await tx.scanConversations({}, 500);
            for (const c of page.items) {
              const first = await tx.scanEntries({ conversationId: c.id, order: "ascending" }, 20);
              if (first.items.some((e) => e.kind === NOTE)) out.push(c.id as number);
            }
            return out;
          }, context);

        const submitTo = async (id: number, task: string, requestId: string, whenBusy: "steer" | "followUp") => {
          const h = await api.conversation(id as never, context);
          if (!h) return false;
          await api.commit(async (tx) => { await tx.appendEntry(id as never, { kind: MSG, data: { requestId } }); }, context);
          await h.submit({ type: "input", content: task, requestId, whenBusy }, context);
          return true;
        };

        switch (args.action) {
          case "spawn": {
            if (!args.task) return text("spawn needs `task`", true);
            const task = args.task;
            const id: number = await api.commit(async (tx) => {
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
                await tx.appendEntry(f.id, { kind: NOTE, data: { task, forkedFrom: api.conversationId } });
                return f.id as number;
              }
              const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
              await configure(tx, c.id, childAgent);
              await tx.appendEntry(c.id, { kind: NOTE, data: { task } });
              return c.id as number;
            }, context);
            await api.details({ conversationId: id as number }, context);
            await submitTo(id, task, `delegate:${id}:0`, "followUp");
            return text(`spawned child ${id}${args.fork ? " (forked)" : ""}`);
          }
          case "steer": {
            if (!args.task || !args.ids?.length) return text("steer needs `task` and `ids`", true);
            const n = Date.now();
            const sent: number[] = [];
            for (const id of args.ids) if (await submitTo(id, args.task, `delegate:${id}:steer:${n}`, "steer")) sent.push(id);
            return text(`steered ${sent.length}/${args.ids.length}: ${sent.join(", ")}`);
          }
          case "stop": {
            for (const id of args.ids ?? []) await (await api.conversation(id as never, context))?.abort(context);
            return text(`stopped ${(args.ids ?? []).join(", ") || "none"}`);
          }
          case "list": {
            const rows = await Promise.all((await known()).map(report));
            return { output: [{ type: "text" as const, text: rows.map((r) => `${r.id}: ${r.state}`).join("\n") || "no children" }], structuredOutput: undefined };
          }
          case "wait": {
            const ids = args.ids?.length ? args.ids : await known();
            if (!ids.length) return text("no children");
            const ms = (args.timeoutSec ?? 120) * 1000;
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              const now = await Promise.all(ids.map(report));
              if (now.every((r) => r.state !== "running")) break;
              await new Promise((r) => setTimeout(r, 50));
            }
            const rows = await Promise.all(ids.map(report));
            return text(rows.map((r) => `[${r.id}] ${r.state}${r.answer ? `\n${r.answer}` : ""}`).join("\n\n"));
          }
        }
      },
    }),
  ],
});
