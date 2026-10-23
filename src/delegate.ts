// Orchestrator extension: `delegate_task` lets a conversation spawn, fork, steer, wait on, list and stop
// parallel subagent conversations. Children are ownerless durable conversations, so they survive the
// spawning tool call and the parent's abort. Each parent records its own children in a conversation document,
// so list/wait/steer/stop only ever touch that parent's children. Replay safety: spawn is keyed by the tool
// call's task id (a rerun after a crash finds the child it already made) and every message has a deterministic requestId.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { ExecTarget } from "./workers.js";
import { AskDoc } from "./ask.js";
import { isRunning, readSessionHandoff, readSessionStatus } from "./session-status.js";
import { Type } from "@earendil-works/pi-ai";
import { configure, defineDoc, defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";

const MSG = "delegate.msg"; // { requestId } per message sent to a child
const NOTE = "delegate.child"; // marker entry written into every child: { task, parent, forkedFrom? }

const git = promisify(execFile);
/** stopped: the parent stopped it (sticky until steered). deadline: epoch ms from spawn timeoutSec. cwd: where it works. */
type ChildRow = { id: number; spawnKey: string; task: string; stopped?: "stopped" | "timeout"; deadline?: number; cwd?: string };

/** Added to every spawn brief. Statuses and summaries must agree, and claims must be checkable. */
const BRIEF_RULES = [
  "Rules for this task:",
  "- If you are blocked on approval or input, call session_handoff and end with 'blocked on <what>'. Never write a completed summary for work that is blocked, denied, or not done.",
  "- Claim only commits, PRs, and files you made yourself.",
  "- End your final message with a fenced block tagged receipt holding JSON: {\"commit_sha\": string|null, \"pr_url\": string|null, \"files_changed\": string[], \"blocked_on\": string|null}.",
].join("\n");

/** The receipt a child ends with, if any. */
function parseReceipt(answer: string | undefined): Record<string, unknown> | undefined {
  const m = answer && /```receipt\s*([\s\S]*?)```/.exec(answer);
  if (!m) return undefined;
  try { const v = JSON.parse(m[1]!); return v && typeof v === "object" ? v : undefined; } catch { return undefined; }
}
/** Check a receipt against git in the child's directory. Only the commit can be checked here; the PR url is reported as claimed. */
async function checkReceipt(r: Record<string, unknown>, cwd: string | undefined): Promise<string> {
  const out: string[] = [];
  const sha = typeof r.commit_sha === "string" ? r.commit_sha : undefined;
  if (sha) {
    if (!cwd || !/^[0-9a-f]{7,40}$/i.test(sha)) out.push(`commit ${sha}: cannot verify`);
    else out.push(await git("git", ["-C", cwd, "cat-file", "-e", `${sha}^{commit}`]).then(() => `commit ${sha}: verified in ${cwd}`, () => `commit ${sha}: NOT FOUND in ${cwd}`));
  }
  if (typeof r.pr_url === "string") out.push(`pr ${r.pr_url}: claimed, not verified`);
  if (Array.isArray(r.files_changed)) out.push(`files_changed: ${r.files_changed.length} claimed`);
  if (typeof r.blocked_on === "string") out.push(`blocked_on: ${r.blocked_on}`);
  return out.length ? out.join("; ") : "empty";
}
/** The children this conversation spawned. A fork starts with none of its parent's children. */
export const Children = defineDoc<{ children: ChildRow[] }>({
  checkpointWhen: () => false,
  kind: "luna.delegate.children",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ children: [] }),
});

const parameters = Type.Object({
  action: Type.Union(
    [Type.Literal("spawn"), Type.Literal("steer"), Type.Literal("wait"), Type.Literal("list"), Type.Literal("stop"), Type.Literal("show")],
    { description: "spawn: start a child; steer: message a child; wait: gather answers; list: show children; stop: abort a child; show: full pending request and recent tool calls of a child" },
  ),
  task: Type.Optional(Type.String({ description: "spawn/steer: the instruction for the child" })),
  fork: Type.Optional(
    Type.Boolean({ description: "spawn: child starts as a zero-copy fork of this conversation's history instead of a blank slate" }),
  ),
  forkAt: Type.Optional(Type.Number({ description: "spawn+fork: entry id to fork at (default: latest settled entry)" })),
  ids: Type.Optional(Type.Array(Type.Number(), { description: "steer/wait/stop: child conversation ids (wait: default all of yours)" })),
  timeoutSec: Type.Optional(Type.Number({ description: "wait: max seconds to wait (default 120, max 1800). spawn: time budget for the child; it is stopped once exceeded (checked on list and wait)" })),
  worktree: Type.Optional(Type.String({ description: "spawn: create a git worktree on a new branch of this name (from the parent's directory) and run the child there" })),
  base: Type.Optional(Type.String({ description: "spawn+worktree: start point for the branch, e.g. origin/dev (default HEAD). origin is fetched first when base has a remote" })),
  notes: Type.Optional(Type.String({ description: "spawn: path of a notes file whose text (first 8000 chars) is put in the child's brief" })),
});

/** `needs_*`: the child stopped (handoff) or waits (ask_user_question) for someone above it. Not m57's approval. */
type ChildReport = { id: number; state: "running" | "done" | "unanswered" | "idle" | "needs_input" | "needs_approval" | "stopped"; answer?: string; reason?: string; cwd?: string };
const blocked = (r: ChildReport) => r.state === "needs_input" || r.state === "needs_approval";

export interface DelegateSettings {
  provider?: string; model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  cwd?: string;
}
export function createDelegateExtension(settings: () => DelegateSettings = () => ({})): Extension {
  const extension: Extension = defineExtension({
    name: "delegate",
    tools: [
      defineTool({
        name: "delegate_task",
        description:
          "Delegate work to parallel subagent conversations. spawn (optionally fork=true to inherit this conversation's history) returns a child id; " +
          "spawn several, keep working, then wait to gather their answers. steer redirects a running child; stop aborts one; list shows yours. " +
          "A child state needs_input or needs_approval means it stopped for you; wait returns at once, show gives the full request. " +
          "You cannot approve for m57: relay the request to m57, then pass his answer with steer. A child never grants approval. " +
          "stop is final until you steer the child. spawn accepts worktree/base (own git worktree), notes (a facts file for the brief) and timeoutSec (budget). " +
          "Children end with a receipt block; commit_sha is checked against git.",
        parameters,
        replay: "safe",
        execute: async (args, api, context) => {
          const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
          const parent = await api.agent(context);
          // Children cannot delegate further, mutate a shared board without a project link, or ask a human (nobody sees a hidden child's questionnaire; they hand off instead).
          // Configured child defaults override the parent.
          const defaults = settings();
          // The configured child cwd is a main-host path; children of a worker session keep the parent's directory.
          const onWorker = !!(await api.commit(async (tx) => (await tx.doc(ExecTarget, api.conversationId)).worker, context));
          const childCwd = onWorker ? parent.cwd : defaults.cwd ?? parent.cwd;
          const childAgent = {
            model: defaults.provider && defaults.model ? { provider: defaults.provider, modelId: defaults.model } : parent.model,
            thinkingLevel: defaults.thinkingLevel ?? parent.thinkingLevel, extensions: { remove: [extension, ...parent.extensions.filter(e => e.name === "board" || e.name === "ask-user")] },
            ...(childCwd ? { cwd: childCwd } : {}),
          } as never;

          const mine = (): Promise<ChildRow[]> =>
            // Copy to plain objects inside the commit: draft proxies are unusable once it settles.
            api.commit(async (tx) => (await tx.doc(Children, api.conversationId)).children.map((c) => ({ id: c.id, spawnKey: c.spawnKey, task: c.task, stopped: c.stopped, deadline: c.deadline, cwd: c.cwd })), context);

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
              // A child that asks or hands off is blocked, whether its turn is still waiting or already ended.
              let reason: string | undefined;
              if (state === "running" || state === "done") {
                const status = await readSessionStatus(tx, id as never, await isRunning(tx, id as never));
                if (status.status === "needs_input" || status.status === "needs_approval") { state = status.status; reason = status.statusReason ?? undefined; }
              }
              const row = (await tx.doc(Children, api.conversationId)).children.find((c) => c.id === id);
              // A stop by the parent or a budget timeout is final until the child is steered again.
              if (row?.stopped) { state = "stopped"; reason = row.stopped === "timeout" ? "stopped: time budget exceeded" : "stopped by the parent"; }
              return { id, state, answer, reason, cwd: row?.cwd };
            }, context);

          const mark = (ids: number[], stopped: "stopped" | "timeout" | undefined) =>
            api.commit(async (tx) => { for (const c of (await tx.doc(Children, api.conversationId)).children) if (ids.includes(c.id)) c.stopped = stopped; }, context);
          // Budget: stop children whose deadline passed while they still run.
          const enforce = async () => {
            const now = Date.now();
            const late = (await mine()).filter((c) => c.deadline && c.deadline < now && !c.stopped);
            for (const c of late) {
              if ((await report(c.id)).state !== "running") continue;
              await mark([c.id], "timeout");
              await (await api.conversation(c.id as never, context))?.abort(context);
            }
          };
          const receiptLine = async (r: ChildReport) => {
            const rc = parseReceipt(r.answer);
            return rc ? `\nreceipt: ${await checkReceipt(rc, r.cwd)}` : r.state === "done" && r.answer ? "\nreceipt: none" : "";
          };
          const detail = (id: number) => api.commit(async (tx) => {
            const out: string[] = [];
            const handoff = await readSessionHandoff(tx, id as never);
            if (handoff) out.push(`handoff ${handoff.status}: ${handoff.reason}`);
            for (const p of (await tx.doc(AskDoc, id as never)).pending) out.push(`pending ${p.purpose ?? "input"} question:\n${JSON.stringify(p.questions, null, 1)}`);
            const calls: string[] = [];
            const page = await tx.scanEntries({ conversationId: id as never, order: "descending" }, 40);
            for (const e of page.items) {
              if (e.kind !== "pi.assistant" || calls.length >= 5) continue;
              for (const m of e.model ?? []) if (m.role === "assistant") for (const c of [...m.content].reverse()) if (c.type === "toolCall" && c.name !== "session_handoff" && calls.length < 5) calls.push(`${c.name} ${JSON.stringify(c.arguments).slice(0, 1500)}`);
            }
            if (calls.length) out.push(`last tool calls (newest first):\n${calls.join("\n")}`);
            return out.join("\n\n") || "no pending request";
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
              let agent = childAgent, wtCwd: string | undefined;
              if (args.worktree && !(await mine()).some((c) => c.spawnKey === spawnKey)) {
                if (onWorker) return text("worktree is not supported for sessions on an execution worker", true);
                const name = args.worktree.replace(/[^\w./-]/g, "-");
                const base = parent.cwd ?? process.cwd();
                wtCwd = join(dirname(base), ".luna-worktrees", `${basename(base)}-${name.replace(/\//g, "-")}`);
                if (args.base?.includes("/")) await git("git", ["-C", base, "fetch", "--quiet", args.base.split("/")[0]!]).catch(() => {});
                try { await git("git", ["-C", base, "worktree", "add", "-b", name, wtCwd, args.base ?? "HEAD"]); }
                catch (e) { return text(`worktree failed: ${((e as { stderr?: string }).stderr || (e as Error).message).trim()}`, true); }
              }
              if (wtCwd) agent = { ...(childAgent as object), cwd: wtCwd } as never;
              let notes = "";
              if (args.notes) {
                try { notes = `Notes from the parent (${args.notes}):\n${readFileSync(args.notes, "utf8").slice(0, 8000)}\n\n`; }
                catch (e) { return text(`notes unreadable: ${(e as Error).message}`, true); }
              }
              const brief = `${notes}${task}\n\n${BRIEF_RULES}`;
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
                  await configure(tx, f.id, agent);
                  await tx.appendEntry(f.id, { kind: NOTE, data: { task, parent: api.conversationId as number, forkedFrom: api.conversationId as number } });
                  childId = f.id as number;
                } else {
                  const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
                  await configure(tx, c.id, agent);
                  // A child works on its parent's machine. Forks copy this document themselves.
                  (await tx.doc(ExecTarget, c.id)).worker = (await tx.doc(ExecTarget, api.conversationId)).worker;
                  await tx.appendEntry(c.id, { kind: NOTE, data: { task, parent: api.conversationId as number } });
                  childId = c.id as number;
                }
                const dir = (agent as { cwd?: string }).cwd;
                doc.children.push({ id: childId, spawnKey, task: task.slice(0, 200), ...(args.timeoutSec ? { deadline: Date.now() + args.timeoutSec * 1000 } : {}), ...(dir ? { cwd: dir } : {}) });
                return { id: childId, reused: false };
              }, context);
              await api.details({ conversationId: id }, context);
              await submitTo(id, brief, `delegate:${id}:0`, "followUp");
              return text(`spawned child ${id}${args.fork ? " (forked)" : ""}${wtCwd ? ` in worktree ${wtCwd}` : ""}${reused ? " (resumed after restart)" : ""}`);
            }
            case "steer": {
              if (!args.task || !args.ids?.length) return text("steer needs `task` and `ids`", true);
              const { ok, foreign } = await owned(args.ids);
              await mark(ok, undefined);
              for (const id of ok) await submitTo(id, args.task, `delegate:${id}:steer:${api.taskId}`, "steer");
              return text(`steered ${ok.length}/${args.ids.length}: ${ok.join(", ")}${foreignNote(foreign)}`, ok.length === 0);
            }
            case "stop": {
              const { ok, foreign } = await owned(args.ids ?? []);
              await mark(ok, "stopped");
              for (const id of ok) await (await api.conversation(id as never, context))?.abort(context);
              return text(`stopped ${ok.join(", ") || "none"}${foreignNote(foreign)}`);
            }
            case "show": {
              const { ok, foreign } = await owned(args.ids ?? []);
              if (!ok.length) return text(`show needs \`ids\` of your children${foreignNote(foreign)}`, true);
              return text((await Promise.all(ok.map(async (id) => `[${id}]\n${await detail(id)}`))).join("\n\n") + foreignNote(foreign));
            }
            case "list": {
              await enforce();
              const kids = await mine();
              const rows = await Promise.all(kids.map(async (k) => ({ ...(await report(k.id)), task: k.task })));
              return text(rows.map((r) => `${r.id}: ${r.state}${r.reason ? ` (${r.reason.slice(0, 120)})` : ""} - ${r.task.slice(0, 80)}${r.cwd && (r.state === "stopped" || r.state === "unanswered") ? ` [work in ${r.cwd}]` : ""}`).join("\n") || "no children");
            }
            case "wait": {
              const { ok: ids, foreign } = args.ids?.length ? await owned(args.ids) : { ok: (await mine()).map((c) => c.id), foreign: [] as number[] };
              if (!ids.length) return text(foreign.length ? `not your children: ${foreign.join(", ")}` : "no children", foreign.length > 0);
              const ms = Math.min(Math.max(args.timeoutSec ?? 120, 1), 1800) * 1000;
              const deadline = Date.now() + ms;
              while (Date.now() < deadline && !context.abortSignal?.aborted) {
                await enforce();
                const now = await Promise.all(ids.map(report));
                if (now.every((r) => r.state !== "running") || now.some(blocked)) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              const rows = await Promise.all(ids.map(report));
              return text((await Promise.all(rows.map(async (r) => `[${r.id}] ${r.state}${r.reason ? `: ${r.reason}` : ""}${r.answer ? `\n${r.answer}` : ""}${await receiptLine(r)}`))).join("\n\n") + foreignNote(foreign));
            }
          }
        },
      }),
    ],
  });

  return extension;
}
export const Delegate = createDelegateExtension();
