// Orchestrator extension: `subagent` lets a conversation spawn, fork, steer, wait on, list and stop
// parallel subagent conversations. Children are ownerless durable conversations, so they survive the
// spawning tool call and the parent's abort. Each parent records its own children in a conversation document,
// so list/wait/steer/stop only ever touch that parent's children. Replay safety: spawn is keyed by the tool
// call's task id (a rerun after a crash finds the child it already made) and every message has a deterministic requestId.
import type { JsonValue } from "@earendil-works/chord/json";
import { readFileSync } from "node:fs";
import { ExecTarget } from "./workers.js";
import { AskDoc } from "./ask.js";
import { readSessionHandoff } from "./session-status.js";
import { nativeCompaction, type CompactionLimits } from "./compaction-limits.js";
import { Type } from "typebox";
import { configure, defineExtension, defineTool, type AgentChange, type ConversationId, type Extension, type TaskId } from "@earendil-works/pi-durable";
import { Children, ChildResult, childRequests, childNotificationId, readChildReport, DELEGATE_CHILD, DELEGATE_MESSAGE, type ChildRow, type ChildReport } from "./delegate-state.js";
import { withChildControl } from "./delegate-control.js";
import { DelegateDeadline } from "./delegate-deadline.js";
import { compileResultSchema, delegateResultTool, RECEIPT_SCHEMA } from "./delegate-results.js";
import { prepareDelegateWorktree } from "./delegate-worktree.js";
import { readDelegationUsage } from "./delegate-usage.js";
import type { DelegateProfile } from "./delegate-profiles.js";
import { resolveThinkingLevel } from "./thinking.js";
import { StringEnum } from "./string-enum.js";
export { Children } from "./delegate-state.js";

/** Added to every spawn brief. Statuses and summaries must agree, and claims must be checkable. */
const BRIEF_RULES = [
  "Rules for this task:",
  "- If you are blocked on approval or input, call session_status and end with 'blocked on <what>'. Never write a completed summary for work that is blocked, denied, or not done.",
  "- Claim only commits, PRs, and files you made yourself. Validation of your result schema is not proof that the work is correct.",
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
    else {
      const code = await (async () => {
        try {
          const proc = Bun.spawn(["git", "-C", cwd, "cat-file", "-e", `${sha}^{commit}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
          return await proc.exited;
        } catch {
          return 1;
        }
      })();
      out.push(code === 0 ? `commit ${sha}: exists in ${cwd} (not task verification)` : `commit ${sha}: NOT FOUND in ${cwd}`);
    }
  }
  if (typeof r.pr_url === "string") out.push(`pr ${r.pr_url}: claimed, not verified`);
  if (Array.isArray(r.files_changed)) out.push(`files_changed: ${r.files_changed.length} claimed`);
  if (typeof r.blocked_on === "string") out.push(`blocked_on: ${r.blocked_on}`);
  return out.length ? out.join("; ") : "empty";
}
const parameters = Type.Object({
  action: StringEnum(
    ["spawn", "steer", "wait", "list", "stop", "show", "profiles", "usage"],
    { description: "spawn: start a child; steer: message a child; wait: gather answers; list: show children; stop: abort a child; show: full pending request and recent tool calls of a child" },
  ),
  profile: Type.Optional(Type.String({ description: "spawn: configured role name; profiles lists roles, tool allowlists, model overrides, and context defaults" })),
  outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "spawn: JSON Schema draft-07 for delegate_result. Defaults to a receipt object. Local references only; at most 32 KiB." })),
  task: Type.Optional(Type.String({ description: "spawn/steer: the instruction for the child" })),
  fork: Type.Optional(
    Type.Boolean({ description: "spawn: child starts as a zero-copy fork of this conversation's history instead of a blank slate" }),
  ),
  forkAt: Type.Optional(Type.Integer({ minimum: 1, description: "spawn+fork: entry id to fork at (default: latest settled entry)" })),
  ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "steer/wait/stop: child conversation ids (wait: default all of yours)" })),
  timeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 2147483, description: "wait: max seconds (default 120, max 1800). spawn or steer: child time budget, enforced by a durable deadline without polling." })),
  worktree: Type.Optional(Type.String({ description: "spawn: create a git worktree on a new branch of this name (from the parent's directory) and run the child there" })),
  base: Type.Optional(Type.String({ description: "spawn+worktree: start point for the branch, e.g. origin/dev (default HEAD). origin is fetched first when base has a remote" })),
  notes: Type.Optional(Type.String({ description: "spawn: path of a notes file whose text (first 8000 chars) is put in the child's brief" })),
});

const blocked = (r: ChildReport) => r.state === "needs_input" || r.state === "needs_approval";

export interface DelegateSettings {
  provider?: string; model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  cwd?: string;
  maxTurns?: number;
  profiles?: Record<string, DelegateProfile>;
}
export function createDelegateExtension(settings: () => DelegateSettings = () => ({}), compaction?: () => CompactionLimits): Extension {
  const extension: Extension = defineExtension({
    name: "delegate",
    tasks: [DelegateDeadline],
    tools: [
      defineTool({
        name: "subagent",
        description:
          "Delegate work to parallel subagent conversations. spawn (optionally fork=true to inherit this conversation's history) returns a child id; " +
          "spawn several, keep working, then wait to gather their answers. steer redirects a running child; stop aborts one; list shows yours. " +
          "A child state needs_input or needs_approval means it stopped for you; wait returns at once, show gives the full request. " +
          "You cannot approve for m57: relay the request to m57, then pass his answer with steer. A child never grants approval. " +
          "stop is final until you steer the child. spawn accepts worktree/base (own git worktree), notes (a facts file for the brief) and timeoutSec (budget). " +
          "New children must submit a schema-validated delegate_result; the default schema is a receipt. Schema validation is not work verification. profiles lists configured roles; usage reports this parent and its children from existing usage ledgers.",
        parameters,
        replay: "safe",
        execute: async (args, api, context) => {
          const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
          const parent = await api.agent(context);
          const mine = (): Promise<ChildRow[]> => api.commit(async tx =>
            JSON.parse(JSON.stringify((await tx.doc(Children, api.conversationId)).children)) as ChildRow[], context);
          const report = (id: number) => api.commit(tx => readChildReport(tx, api.conversationId, id), context);
          const collect = (id: number) => api.commit(async tx => {
            const value = await readChildReport(tx, api.conversationId, id);
            const noticeId = childNotificationId(value);
            const row = (await tx.doc(Children, api.conversationId)).children.find(c => c.id === id);
            if (noticeId && row) {
              const prior = row.collected?.noticeId === noticeId ? await tx.task(row.collected.taskId as TaskId) : undefined;
              if (prior?.state.status !== "terminal" || prior.state.outcome.status !== "completed")
                row.collected = { noticeId, taskId: Number(api.taskId) };
            }
            return value;
          }, context);
          const receiptLine = async (r: ChildReport) => {
            const rc = r.result && typeof r.result === "object" && !Array.isArray(r.result) ? r.result : parseReceipt(r.answer);
            if (rc && await api.commit(async tx => (await tx.doc(ExecTarget, r.id as ConversationId)).worker, context))
              return "\nreceipt: remote execution worker; commit and claims are not verified on this host";
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
              for (const m of e.model ?? []) if (m.role === "assistant") for (const c of [...m.content].reverse()) if (c.type === "toolCall" && c.name !== "session_status" && calls.length < 5) calls.push(`${c.name} ${JSON.stringify(c.arguments).slice(0, 1500)}`);
            }
            if (calls.length) out.push(`last tool calls (newest first):\n${calls.join("\n")}`);
            return out.join("\n\n") || "no pending request";
          }, context);

          // Request identities live in the parent document; legacy rows migrate with a full own-entry scan.
          const submitTo = async (id: number, task: string, requestId: string, whenBusy: "steer" | "followUp") => {
            const handle = await api.conversation(id as ConversationId, context);
            if (!handle) throw new Error(`Child ${id} no longer exists.`);
            await api.commit(async tx => {
              const row = (await tx.doc(Children, api.conversationId)).children.find(c => c.id === id);
              if (!row || row.stopped || row.stopping) throw new Error(`Child ${id} is stopped or stopping.`);
              const requests = await childRequests(tx, api.conversationId, id);
              if (!requests.includes(requestId)) {
                row.requests = [...requests, requestId];
                await tx.appendEntry(id as ConversationId, { kind: DELEGATE_MESSAGE, data: { requestId } });
              }
            }, context);
            await handle.submit({ type: "input", content: task, requestId, whenBusy }, context);
          };

          // Reject ids this conversation did not spawn: a parent must not drive another parent's children.
          const owned = async (ids: number[]) => {
            const known = new Set((await mine()).map((c) => c.id));
            return { ok: ids.filter((i) => known.has(i)), foreign: ids.filter((i) => !known.has(i)) };
          };
          const foreignNote = (f: number[]) => (f.length ? ` (not your children: ${f.join(", ")})` : "");

          switch (args.action) {
            case "usage": return text(JSON.stringify(await api.commit(tx => readDelegationUsage(tx, api.conversationId), context), null, 2));
            case "profiles": {
              const profiles = settings().profiles ?? {};
              return text(JSON.stringify(profiles, null, 2));
            }
            case "spawn": {
              if (!args.task?.trim()) return text("spawn needs `task`", true);
              const spawnKey = String(api.taskId);
              const prior = (await mine()).find(c => c.spawnKey === spawnKey);
              if (prior) {
                await api.details({ conversationId: prior.id }, context);
                await withChildControl(prior.id, () => submitTo(prior.id, prior.brief ?? `${args.task}\n\n${BRIEF_RULES}`, `delegate:${prior.id}:0`, "followUp"));
                return text(`spawned child ${prior.id} (resumed after restart)`);
              }
              const defaults = settings();
              const profile = args.profile && defaults.profiles && Object.hasOwn(defaults.profiles, args.profile) ? defaults.profiles[args.profile] : undefined;
              if (args.profile && !profile) return text(`Unknown child profile '${args.profile}'. Use profiles to list configured roles.`, true);
              const fork = args.fork ?? profile?.context === "fork";
              const onWorker = !!(await api.commit(async tx => (await tx.doc(ExecTarget, api.conversationId)).worker, context));
              if (args.worktree && onWorker) return text("worktree is not supported for sessions on an execution worker", true);
              const model = profile?.provider && profile.model ? { provider: profile.provider, modelId: profile.model }
                : defaults.provider && defaults.model ? { provider: defaults.provider, modelId: defaults.model } : parent.model;
              if (model && !api.models.getModel(model.provider, model.modelId)) return text(`Unknown child model ${model.provider}/${model.modelId}.`, true);
              // Both lists already enforce the parent's enabled tools and model-caller restrictions.
              const available = new Map([...parent.tools, ...parent.deferred].map(tool => [tool.name, tool]));
              const requested = profile?.tools ?? parent.tools.map(tool => tool.name);
              const forbidden = new Set(["subagent", "session_crew", "ask_user_question", "board", "mail_send"]);
              const missing = requested.filter(name => !forbidden.has(name) && !available.has(name));
              if (missing.length) return text(`Child profile requires unavailable tools: ${missing.join(", ")}.`, true);
              const tools = requested.filter(name => !forbidden.has(name)).map(name => available.get(name)!);
              if (!tools.some(tool => tool.name === delegateResultTool.name)) tools.push(delegateResultTool);
              const schema = args.outputSchema ?? RECEIPT_SCHEMA;
              try { compileResultSchema(schema); } catch (error) { return text((error as Error).message, true); }
              let forkAt: number | undefined;
              if (fork) {
                forkAt = await api.memo<number>("delegate.forkAt", context);
                if (forkAt === undefined) {
                  const candidate = await api.commit(async tx => {
                    if (args.forkAt !== undefined) {
                      const at = args.forkAt as never;
                      const visible = (await tx.scanEntries({ conversationId: api.conversationId, minEntryId: at, maxEntryId: at }, 1)).items[0];
                      if (!visible) throw new Error("forkAt must be a visible entry of this conversation.");
                      return Number(visible.id);
                    }
                    let cursor;
                    do {
                      const page = await tx.scanEntries({ conversationId: api.conversationId, order: "descending" }, 200, cursor);
                      const entry = page.items.find(e => e.kind !== "pi.assistant");
                      if (entry) return Number(entry.id);
                      cursor = page.next;
                    } while (cursor);
                    throw new Error("nothing to fork yet; use fork=false");
                  }, context);
                  forkAt = await api.memo("delegate.forkAt", candidate, context);
                }
              }
              let notes = "";
              if (args.notes) {
                try { notes = `Notes from the parent (${args.notes}):\n${readFileSync(args.notes, "utf8").slice(0, 8000)}\n\n`; }
                catch (error) { return text(`notes unreadable: ${(error as Error).message}`, true); }
              }
              // Validate and read every input before making the external worktree allocation.
              let cwd = onWorker ? parent.cwd : defaults.cwd ?? parent.cwd;
              if (args.worktree) {
                try { cwd = await prepareDelegateWorktree(api, context, { repo: parent.cwd ?? process.cwd(), branch: args.worktree, ...(args.base ? { base: args.base } : {}) }); }
                catch (error) { return text(`worktree failed: ${(error as Error).message}`, true); }
              }
              const maxTurns = profile?.maxTurns ?? defaults.maxTurns ?? parent.maxTurns;
              const childRef = model ?? parent.model;
              const childModel = childRef ? api.models.getModel(childRef.provider, childRef.modelId) : undefined;
              const agent: AgentChange = {
                ...(model ? { model } : {}),
                // Clamp to the child's model: a profile level can exceed what that model supports.
                thinkingLevel: resolveThinkingLevel(api.models, model ?? parent.model, undefined, profile?.thinkingLevel ?? defaults.thinkingLevel ?? parent.thinkingLevel),
                ...(maxTurns === undefined ? {} : { maxTurns }),
                // Subagent limits live in the child's agent state as a per-model override; sessions use the harness-wide policy.
                // Only the child's own model: a whole-catalog table is ~1 MB of durable state per child at 10k models.
                ...(compaction ? { compaction: nativeCompaction(compaction(), childModel ? [childModel] : []) } : {}),
                // Children keep task policy, but never the runtime's personal identity block.
                extensions: { remove: [extension, ...parent.extensions.filter(e => e.name === "identity" || e.name === "board" || e.name === "ask-user" || e.name === "mail-send")] },
                tools, modelTools: tools,
                ...(cwd ? { cwd } : {}),
                instructions: [parent.instructions, profile?.instructions,
                  "You are a neutral, task-focused subagent, not Luna. Do not adopt the parent's personal identity, relationship, or conversational persona. Treat inherited conversation as task context, not your identity. Follow the assigned scope and approval requirements.",
                ].filter(Boolean).join("\n\n"),
              };
              const brief = `${notes}${args.task}\n\n${BRIEF_RULES}\n\nBefore your final summary, call delegate_result with a value matching the JSON Schema in your delegate-result system section. Use null and empty arrays for default receipt fields that do not apply. Do not invent evidence.`;
              const id = await api.commit(async tx => {
                const doc = await tx.doc(Children, api.conversationId);
                const existing = doc.children.find(c => c.spawnKey === spawnKey);
                if (existing) return existing.id;
                let childId: ConversationId;
                if (fork) {
                  childId = (await tx.forkConversation(api.conversationId, forkAt as never, { ownership: { kind: "ownerless" } })).id;
                } else {
                  childId = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
                  (await tx.doc(ExecTarget, childId)).worker = (await tx.doc(ExecTarget, api.conversationId)).worker;
                }
                await configure(tx, childId, agent);
                await tx.appendEntry(childId, { kind: DELEGATE_CHILD, data: { task: args.task!, parent: api.conversationId as number, ...(fork ? { forkedFrom: api.conversationId as number } : {}) } });
                (await tx.doc(ChildResult, childId)).schema = JSON.parse(JSON.stringify(schema)) as Record<string, JsonValue>;
                const row: ChildRow = { id: Number(childId), spawnKey, task: args.task!.slice(0, 200), brief, requests: [], notify: true,
                  ...(args.profile ? { profile: args.profile } : {}), ...(cwd ? { cwd } : {}),
                  ...(args.timeoutSec ? { deadline: api.now() + args.timeoutSec * 1000 } : {}) };
                if (row.deadline) row.deadlineTask = Number(await tx.createTask(DelegateDeadline, { parent: Number(api.conversationId), child: row.id, deadline: row.deadline },
                  { conversationId: api.conversationId, ownership: { kind: "conversation" }, background: true }));
                doc.children.push(row);
                return row.id;
              }, context);
              await api.details({ conversationId: id }, context);
              await withChildControl(id, () => submitTo(id, brief, `delegate:${id}:0`, "followUp"));
              return text(`spawned child ${id}${fork ? " (forked)" : ""}${args.profile ? ` [${args.profile}]` : ""}${args.worktree ? ` in worktree ${cwd}` : ""}`);
            }
            case "steer": {
              if (!args.task?.trim() || !args.ids?.length) return text("steer needs `task` and `ids`", true);
              const { ok, foreign } = await owned(args.ids);
              for (const id of ok) await withChildControl(id, async () => {
                const requestId = `delegate:${id}:steer:${api.taskId}`;
                await api.commit(async tx => {
                  const row = (await tx.doc(Children, api.conversationId)).children.find(c => c.id === id)!;
                  const requests = await childRequests(tx, api.conversationId, id);
                  if (requests.includes(requestId)) return;
                  if (row.stopping) throw new Error(`Child ${id} is still stopping. Wait for the stop to finish before steering.`);
                  if (row.deadlineTask) row.cancelDeadlines = [...(row.cancelDeadlines ?? []), row.deadlineTask];
                  delete row.deadlineTask; delete row.stopped; delete row.deadline; row.notify = true;
                  row.requests = [...requests, requestId];
                  await tx.appendEntry(id as ConversationId, { kind: DELEGATE_MESSAGE, data: { requestId } });
                  if (args.timeoutSec) {
                    row.deadline = api.now() + args.timeoutSec * 1000;
                    row.deadlineTask = Number(await tx.createTask(DelegateDeadline, { parent: Number(api.conversationId), child: id, deadline: row.deadline },
                      { conversationId: api.conversationId, ownership: { kind: "conversation" }, background: true }));
                  }
                }, context);
                await submitTo(id, `${args.task}\n\nIf your task has a result schema, call delegate_result again for this input before your final summary.`, requestId, "steer");
              });
              return text(`steered ${ok.length}/${args.ids.length}: ${ok.join(", ")}${foreignNote(foreign)}`, ok.length === 0);
            }
            case "stop": {
              const { ok, foreign } = await owned(args.ids ?? []);
              for (const id of ok) await withChildControl(id, async () => {
                await api.commit(async tx => {
                  const row = (await tx.doc(Children, api.conversationId)).children.find(c => c.id === id)!;
                  row.stopped = "stopped"; row.stopping = true;
                }, context);
                await (await api.conversation(id as ConversationId, context))?.abort(context);
                await api.commit(async tx => {
                  const row = (await tx.doc(Children, api.conversationId)).children.find(c => c.id === id);
                  if (row) {
                    delete row.stopping;
                    if (row.deadlineTask) row.cancelDeadlines = [...(row.cancelDeadlines ?? []), row.deadlineTask];
                    delete row.deadlineTask;
                  }
                }, context);
              });
              return text(`stopped ${ok.join(", ") || "none"}${foreignNote(foreign)}`);
            }
            case "show": {
              const { ok, foreign } = await owned(args.ids ?? []);
              if (!ok.length) return text(`show needs \`ids\` of your children${foreignNote(foreign)}`, true);
              return text((await Promise.all(ok.map(async id => {
                const r = await collect(id);
                return `[${id}] ${r.state}${r.reason ? `: ${r.reason}` : ""}\n${await detail(id)}${r.answer ? `\n${r.answer}` : ""}${r.result !== undefined ? `\nvalidated result: ${JSON.stringify(r.result)}` : ""}`;
              }))).join("\n\n") + foreignNote(foreign));
            }
            case "list": {
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
                const now = await Promise.all(ids.map(report));
                if (now.every((r) => r.state !== "running") || now.some(blocked)) break;
                await new Promise((r) => setTimeout(r, 250));
              }
              const rows = await Promise.all(ids.map(collect));
              return text((await Promise.all(rows.map(async (r) => `[${r.id}] ${r.state}${r.reason ? `: ${r.reason}` : ""}${r.answer ? `\n${r.answer}` : ""}${r.result !== undefined ? `\nvalidated result: ${JSON.stringify(r.result)}` : ""}${await receiptLine(r)}`))).join("\n\n") + foreignNote(foreign));
            }
          }
        },
      }),
    ],
  });

  return extension;
}
export const Delegate = createDelegateExtension();
