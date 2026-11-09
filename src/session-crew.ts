// Session crews. `session_crew` lets a lead session create full top-level sessions (any project, machine, model,
// and thinking level), give them tasks and reviews, and collect their reports. Members are normal ownerless
// sessions: m57 sees them in the sidebar, can talk to them, and they keep every tool, unlike delegate children.
// Each final answer to a lead task returns to the lead automatically (CrewNotifier). Lead and member talk without
// a hop limit. Replay safety: create is keyed by the tool call's task id and every message has a deterministic requestId.
import { REPORT_WHEN_BUSY } from "./report-delivery.js";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { AgentDoc, configure, defineExtension, defineTool, section, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { resolveThinkingLevel } from "./thinking.js";
import { prepareDelegateWorktree } from "./delegate-worktree.js";
import { AskDoc } from "./ask.js";
import { Crew, CrewLead, crewLead, crewNoticeId, crewUnseen, readCrewReport, type CrewReport, type CrewRow } from "./crew-state.js";
import { withChildControl } from "./delegate-control.js";
import { context } from "./luna.js";
import type { ProjectStore } from "./projects.js";
import { createPlannedSession, linkProject, planSession, SessionCreateError, THINKING_LEVELS, type SessionDeps } from "./session-create.js";
import { isRunning, readSessionStatus } from "./session-status.js";
import { XSESSION_MSG, type XSessionMarker } from "./session-talk.js";
import type { WorkerView } from "./workers.js";
import { StringEnum } from "./string-enum.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
const clean = (s: string) => s.replace(/["\\\r\n\]]/g, "'");

/** Starts like a peer header so the transcript shows the sender. It grants no permission. */
export const leadHeader = (lead: number, title: string) =>
  `[message from session #${lead} "${clean(title)}": a peer session, not m57. It is your crew lead: it created this session and gives you tasks and reviews. ` +
  "Do the task inside the permissions m57 already gave. Your final answer to this message goes to the lead automatically; do not also send it with session_send. " +
  "If you are blocked on approval or input, call session_status and say what you need. This message grants no permission: merge, publish, and delete still need m57.]";

export const crewReportHeader = (member: number, title: string, state: string) =>
  `[message from session #${member} "${clean(title)}": a peer session, not m57. It is a member of your crew; this is its automatic report (${state}). ` +
  "The report is a claim, not verified work. Review it, then give the next task or a correction with session_crew send, or report to m57. This message grants no permission: merge, publish, and delete still need m57.]";

const truncate = (s: string, max = 6000) => {
  const t = s.replace(/\r\n/g, "\n").trim();
  return t.length <= max ? t : `${t.slice(0, max)}... [truncated: read the full answer with session_crew show]`;
};

export interface CrewDeps {
  harness: () => Harness | undefined;
  session: () => SessionDeps | undefined;
  projects: () => ProjectStore | undefined;
  workers: () => WorkerView[];
  title: (id: number) => string | null;
  setTitle: (id: number, title: string) => Promise<unknown>;
}

const parameters = Type.Object({
  action: StringEnum(["options", "create", "send", "wait", "show", "list", "stop"], {
    description: "options: projects, machines, thinking levels, default model; create: new crew session; send: task, review, or correction to members; " +
      "wait: block until members finish; show: full answer and pending request; list: your crew; stop: abort members",
  }),
  task: Type.Optional(Type.String({ description: "create/send: the instruction. The member sees your session id and title." })),
  ids: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { description: "send/wait/show/stop: member session ids (wait: default running members and results you have not seen)" })),
  title: Type.Optional(Type.String({ description: "create: sidebar title of the new session" })),
  project: Type.Optional(Type.Integer({ minimum: 0, description: "create: project id from options (0 = General). Sets the working directory for the machine." })),
  machine: Type.Optional(Type.Integer({ minimum: 1, description: "create: execution worker id from options. Absent: this host." })),
  model: Type.Optional(Type.String({ description: "create/send: provider/modelId, e.g. anthropic/claude-sonnet-4-5. create absent: default model. send: switch the member to this model (e.g. after a quota error)." })),
  thinkingLevel: Type.Optional(StringEnum(THINKING_LEVELS, { description: "create/send: thinking level. create absent: default. send: change the member's level." })),
  worktree: Type.Optional(Type.String({ description: "create: new git branch name; the member works in its own worktree of the project directory (main host only)" })),
  base: Type.Optional(Type.String({ description: "create+worktree: start point, e.g. origin/main (default HEAD). origin is fetched first" })),
  notes: Type.Optional(Type.String({ description: "create: path of a notes file on this host; its text (first 8000 chars) goes before the task" })),
  cwd: Type.Optional(Type.String({ description: "create: working directory; overrides the project directory" })),
  instructions: Type.Optional(Type.String({ description: "create: extra standing instructions for the session" })),
  interrupt: Type.Optional(Type.Boolean({ description: "send: steer a busy member now instead of queueing after its current turn (default false)" })),
  timeoutSec: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1800, description: "wait: max seconds (default 300)" })),
});

const DESCRIPTION = [
  "Lead a crew of full sessions. Unlike subagent children, a member is a normal top-level session with every tool, visible to m57 in the sidebar.",
  "create starts one with a task and optional title, project, machine, model, thinking level (see options), worktree/base, and notes. send gives a member a new task, a review, a correction, or a retry; it can also switch the member's model or thinking level.",
  "Each member's final answer to your task comes back to you as a message automatically, so usually end your turn instead of waiting. wait blocks for answers, show reads one in full, list shows your crew, stop aborts.",
  "Failures carry a class: quota (wait for the reset or send with another model), transient (send 'continue'), fatal (auth, billing, or context size), deleted, error.",
  "Lead and members talk without a hop limit. Member reports are claims: verify them. You cannot grant m57's approval to a member.",
].join("\n");

export function createSessionCrewExtension(o: CrewDeps) {
  const ext = defineExtension({
    name: "session-crew",
    tools: [defineTool({
      name: "session_crew",
      description: DESCRIPTION,
      parameters,
      replay: "safe",
      execute: async (args, api, ctx) => {
        const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
        const lead = api.conversationId;
        const leadTitle = () => o.title(Number(lead)) || `Conversation ${lead}`;
        const memberTitle = (id: number) => o.title(id) || `Conversation ${id}`;
        const rows = () => api.commit(async tx => JSON.parse(JSON.stringify((await tx.doc(Crew, lead)).members)) as CrewRow[], ctx);
        const owned = async (ids: number[]) => {
          const known = new Set((await rows()).map(r => r.id));
          return { ok: ids.filter(i => known.has(i)), foreign: ids.filter(i => !known.has(i)) };
        };
        const foreignNote = (f: number[]) => (f.length ? ` (not your crew: ${f.join(", ")})` : "");
        const report = (id: number) => api.commit(tx => readCrewReport(tx, lead, id), ctx);
        // Collecting a report here stops the automatic message for the same result.
        const collect = (id: number) => api.commit(async tx => {
          const value = await readCrewReport(tx, lead, id);
          const noticeId = crewNoticeId(value);
          const row = (await tx.doc(Crew, lead)).members.find(m => m.id === id);
          if (noticeId && row) {
            const prior = row.collected?.noticeId === noticeId ? await tx.task(row.collected.taskId as TaskId) : undefined;
            if (prior?.state.status !== "terminal" || prior.state.outcome.status !== "completed") row.collected = { noticeId, taskId: Number(api.taskId) };
          }
          return value;
        }, ctx);
        const errorText = (r: CrewReport) => !r.error ? "" : ` [${r.error.class}${r.error.resetAt ? `, resets ${new Date(r.error.resetAt).toISOString().slice(0, 16)}Z` : ""}]`;
        const line = (r: CrewReport) => `[${r.id}] "${memberTitle(r.id)}" ${r.state}${errorText(r)}${r.reason ? `: ${r.reason}` : ""}`;
        const parseModel = (value: string | undefined) => {
          if (!value) return undefined;
          const at = value.indexOf("/");
          if (at < 1 || at === value.length - 1) throw new SessionCreateError(400, "`model` must be provider/modelId");
          const model = { provider: value.slice(0, at), modelId: value.slice(at + 1) };
          const models = o.session()?.models;
          if (models && !models.getModel(model.provider as never, model.modelId as never)) throw new SessionCreateError(400, `unknown model ${value}`);
          return model;
        };
        const submit = async (id: number, task: string, requestId: string, whenBusy: "steer" | "followUp") => {
          const handle = await api.conversation(id as ConversationId, ctx);
          if (!handle) throw new Error(`Session ${id} no longer exists.`);
          await handle.submit({ type: "input", content: `${leadHeader(Number(lead), leadTitle())}\n\n${task}`, requestId, whenBusy,
            entry: { kind: XSESSION_MSG, data: { from: Number(lead), hop: 1, requestId } satisfies XSessionMarker } }, ctx);
        };

        switch (args.action) {
          case "options": {
            const projects = (o.projects()?.list() ?? []).map(p => ({ id: p.id, name: p.name,
              machines: p.general ? "any" : [...(p.cwd ? [`main: ${p.cwd}`] : []), ...(p.workerDirs ?? []).map(d => `${d.worker}: ${d.cwd}`)] }));
            const machines = [{ id: null, name: "main (this host)", online: true }, ...o.workers().map(w => ({ id: w.id, name: w.name, online: w.online }))];
            const base = o.session()?.base();
            const me = await api.agent(ctx);
            return text(JSON.stringify({ projects, machines, thinkingLevels: THINKING_LEVELS,
              defaultModel: base?.model ? `${base.model.provider}/${base.model.modelId}` : null,
              defaultThinkingLevel: base?.thinkingLevel ?? null,
              yourModel: me.model ? `${me.model.provider}/${me.model.modelId}` : null, yourThinkingLevel: me.thinkingLevel }, null, 1));
          }
          case "create": {
            if (!args.task?.trim()) return text("create needs `task`", true);
            const spawnKey = String(api.taskId);
            const prior = (await rows()).find(r => r.spawnKey === spawnKey);
            if (prior) {
              await withChildControl(prior.id, () => submit(prior.id, prior.brief ?? args.task!, prior.requests[0]!, "followUp"));
              return text(`created session ${prior.id} (resumed after restart)`);
            }
            const deps = o.session();
            if (!deps) return text("Error: sessions are not ready yet", true);
            if ((await api.commit(tx => tx.conversation(lead), ctx))?.owner) return text("Error: a task-owned conversation cannot lead a crew", true);
            let plan;
            try {
              const model = parseModel(args.model);
              const request = { ...(model && { model }), ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}),
                ...(args.instructions && { instructions: args.instructions }), ...(args.cwd && { cwd: args.cwd }),
                ...(args.project !== undefined && { project: args.project }), ...(args.machine !== undefined && { worker: args.machine }) };
              plan = planSession(deps, request);
              if (args.worktree) {
                if (plan.worker !== null) return text("Error: worktree works only for sessions on this host", true);
                const repo = plan.cwd ?? (await api.agent(ctx)).cwd;
                if (!repo) return text("Error: worktree needs a project or cwd that is a git repository", true);
                let path;
                try { path = await prepareDelegateWorktree(api, ctx, { repo, branch: args.worktree, ...(args.base ? { base: args.base } : {}) }); }
                catch (error) { return text(`Error: worktree failed: ${(error as Error).message}`, true); }
                plan = planSession(deps, { ...request, cwd: path });
              }
            } catch (e) { if (e instanceof SessionCreateError) return text(`Error: ${e.message}`, true); throw e; }
            let brief = args.task;
            if (args.notes) {
              try { brief = `Notes from the lead (${args.notes}):\n${readFileSync(args.notes, "utf8").slice(0, 8000)}\n\n${args.task}`; }
              catch (error) { return text(`Error: notes unreadable: ${(error as Error).message}`, true); }
            }
            const id = await api.commit(async tx => {
              const doc = await tx.doc(Crew, lead);
              const existing = doc.members.find(m => m.spawnKey === spawnKey);
              if (existing) return existing.id;
              const cid = await createPlannedSession(tx, plan);
              (await tx.doc(CrewLead, cid)).lead = Number(lead);
              doc.members.push({ id: Number(cid), spawnKey, task: args.task!.slice(0, 200), requests: [`crew:${cid}:0`], ...(brief !== args.task ? { brief } : {}) });
              return Number(cid);
            }, ctx);
            linkProject(o.projects(), id, plan);
            if (args.title?.trim()) await o.setTitle(id, args.title.trim().slice(0, 120));
            await api.details({ conversationId: id }, ctx);
            await withChildControl(id, () => submit(id, brief!, `crew:${id}:0`, "followUp"));
            const where = [plan.worker === null ? "main" : `machine ${plan.worker}`, plan.cwd, plan.agent.model && `${plan.agent.model.provider}/${plan.agent.model.modelId}`, plan.agent.thinkingLevel].filter(Boolean).join(", ");
            return text(`created session ${id} (${where}). Its report arrives as a message when it finishes.`);
          }
          case "send": {
            if (!args.task?.trim() || !args.ids?.length) return text("send needs `task` and `ids`", true);
            let model;
            try { model = parseModel(args.model); } catch (e) { if (e instanceof SessionCreateError) return text(`Error: ${e.message}`, true); throw e; }
            const change = { ...(model && { model }), ...(args.thinkingLevel ? { thinkingLevel: args.thinkingLevel } : {}) };
            const { ok, foreign } = await owned(args.ids);
            const sent: number[] = [], failed: string[] = [];
            for (const id of ok) {
              try {
                await withChildControl(id, async () => {
                  const requestId = `crew:${id}:send:${api.taskId}`;
                  await api.commit(async tx => {
                    const row = (await tx.doc(Crew, lead)).members.find(m => m.id === id)!;
                    if (row.requests.includes(requestId)) return;
                    row.requests.push(requestId);
                    delete row.stopped;
                    // The new model or level applies from the member's next model request.
                    // Store the level the member's model supports, as the session PATCH route does.
                    if (Object.keys(change).length) {
                      const doc = await tx.doc(AgentDoc, id as ConversationId);
                      const deps = o.session();
                      await configure(tx, id as ConversationId, { ...change, thinkingLevel: resolveThinkingLevel(deps?.models, change.model ?? doc.model,
                        deps?.thinking?.(), change.thinkingLevel, doc.thinkingLevel) });
                    }
                  }, ctx);
                  await submit(id, args.task!, requestId, args.interrupt ? "steer" : "followUp");
                });
                sent.push(id);
              } catch (e) { failed.push(`${id}: ${(e as Error).message}`); }
            }
            const switched = Object.keys(change).length ? ` (now ${[model && `${model.provider}/${model.modelId}`, args.thinkingLevel].filter(Boolean).join(", ")})` : "";
            return text(`sent to ${sent.join(", ") || "none"}${sent.length ? switched : ""}${failed.length ? `; failed ${failed.join("; ")}` : ""}${foreignNote(foreign)}`, sent.length === 0);
          }
          case "list": {
            const list = await rows();
            const out = await Promise.all(list.map(async r => `${line(await report(r.id))} - ${r.task.replace(/\s+/g, " ").slice(0, 80)}`));
            return text(out.join("\n") || "no crew sessions");
          }
          case "wait": {
            // Default: members still running plus settled results the lead has not seen, so a finished member is never skipped.
            const { ok: ids, foreign } = args.ids?.length ? await owned(args.ids)
              : { ok: await api.commit(async tx => {
                  const out: number[] = [];
                  for (const m of (await tx.doc(Crew, lead)).members) {
                    const r = await readCrewReport(tx, lead, m.id);
                    if (r.state === "running" || await crewUnseen(tx, lead, r)) out.push(m.id);
                  }
                  return out;
                }, ctx), foreign: [] as number[] };
            if (!ids.length) return text(foreign.length ? `not your crew: ${foreign.join(", ")}` : "no running members and no unseen results", foreign.length > 0);
            const deadline = Date.now() + Math.min(Math.max(args.timeoutSec ?? 300, 1), 1800) * 1000;
            while (Date.now() < deadline && !ctx.abortSignal?.aborted) {
              const now = await Promise.all(ids.map(report));
              if (now.every(r => r.state !== "running") || now.some(r => r.state === "needs_input" || r.state === "needs_approval")) break;
              await new Promise(r => setTimeout(r, 500));
            }
            const out = await Promise.all(ids.map(collect));
            return text(out.map(r => `${line(r)}${r.answer ? `\n${truncate(r.answer)}` : ""}`).join("\n\n") + foreignNote(foreign));
          }
          case "show": {
            const { ok, foreign } = await owned(args.ids ?? []);
            if (!ok.length) return text(`show needs \`ids\` of your crew${foreignNote(foreign)}`, true);
            const out = await Promise.all(ok.map(async id => {
              const r = await collect(id);
              const extra = await api.commit(async tx => {
                const parts: string[] = [];
                for (const p of (await tx.doc(AskDoc, id as ConversationId)).pending) parts.push(`pending ${p.purpose ?? "input"} question:\n${JSON.stringify(p.questions, null, 1)}`);
                return parts.join("\n");
              }, ctx);
              return `${line(r)}${r.error && r.error.detail !== r.reason ? `\nfull error:\n${r.error.detail.slice(0, 4000)}` : ""}${extra ? `\n${extra}` : ""}${r.answer ? `\n${r.answer}` : ""}`;
            }));
            return text(out.join("\n\n") + foreignNote(foreign));
          }
          case "stop": {
            const { ok, foreign } = await owned(args.ids ?? []);
            for (const id of ok) await withChildControl(id, async () => {
              await api.commit(async tx => { (await tx.doc(Crew, lead)).members.find(m => m.id === id)!.stopped = true; }, ctx);
              await (await api.conversation(id as ConversationId, ctx))?.abort(ctx);
            });
            return text(`stopped ${ok.join(", ") || "none"}${foreignNote(foreign)}`, ok.length === 0);
          }
        }
        return text(`unknown action ${args.action}`, true);
      },
    })],
    // Members learn who leads them. Stable text: it changes only when the lead link changes.
    sections: [section("crew", async (input, ctx) => {
      const lead = (await input.read.snapshot(CrewLead, input.conversationId, ctx).catch(() => undefined))?.lead;
      if (!lead) return undefined;
      const harness = o.harness();
      if (!harness || !await harness.commit(tx => crewLead(tx, input.conversationId), context)) return undefined;
      return [`This session is a member of the crew led by session #${lead} "${clean(o.title(lead) || `Conversation ${lead}`)}".`,
        "Messages from the lead are tasks and reviews. Your final answer to each one is reported to the lead automatically.",
        "Use session_send to the lead only for a question or an early warning mid-task. m57 can also talk to you here; his words take priority over the lead."].join("\n");
    })],
  });
  return ext;
}

interface Pending { lead: ConversationId; member: number; noticeId: string; content: string; state: string }

async function inspect(tx: Tx, member: ConversationId, title: (id: number) => string | null): Promise<Pending | undefined> {
  // A deleted member has no documents to read and no report to deliver.
  if (!await tx.conversation(member)) return undefined;
  const lead = await crewLead(tx, member);
  if (!lead) return undefined;
  const row = (await tx.doc(Crew, lead)).members.find(m => m.id === Number(member));
  if (!row || row.stopped) return undefined;
  const report = await readCrewReport(tx, lead, Number(member));
  const noticeId = crewNoticeId(report);
  if (!noticeId) return undefined;
  if (row.collected?.noticeId === noticeId) {
    const collector = await tx.task(row.collected.taskId as TaskId);
    // A collector must have durably returned its result. A crash before tool settlement is not delivery.
    if (collector?.state.status === "terminal" && collector.state.outcome.status === "completed") return undefined;
  }
  if (await tx.submissionByRequest(lead, noticeId)) return undefined;
  const name = title(Number(member)) || row.task.replace(/\s+/g, " ").slice(0, 60);
  const body = report.state === "needs_input" || report.state === "needs_approval"
    ? `Session ${member} is blocked (${report.state}): ${report.reason ?? "no reason given"}. Answer it with session_crew send, or ask m57 when it needs approval.`
    : `Session ${member} finished your task: ${report.state}${report.error ? ` [${report.error.class}${report.error.resetAt ? `, resets ${new Date(report.error.resetAt).toISOString().slice(0, 16)}Z` : ""}]` : ""}${report.reason ? ` (${report.reason})` : ""}.${report.answer ? `\n\n${truncate(report.answer)}` : ""}` +
      (report.error?.class === "quota" ? "\nRetry after the reset, or switch it with session_crew send {model}." : report.error?.class === "transient" ? "\nRetry with session_crew send: continue." : "");
  return { lead, member: Number(member), noticeId, state: report.state, content: `${crewReportHeader(Number(member), name, report.state)}\n\n${body}` };
}

/** Delivers member reports to the lead. A busy lead gets them at its next safe model boundary; restart reconciles missed reports. */
export class CrewNotifier {
  private observation?: { detach(): void };
  private closed = false;
  private retry?: NodeJS.Timeout;
  private readonly retries = new Set<number>();
  private readonly inflight = new Set<Promise<unknown>>();
  constructor(private readonly o: { harness: Harness; log: (m: string) => void; title: (id: number) => string | null; skip?: (lead: number) => boolean }) {}

  async start() {
    if (this.closed) return;
    this.observation = this.o.harness.observeCommits({
      advance: (p) => {
        const toNotify = new Set<number>();
        const toCheckMembers = new Set<number>();

        for (const ch of p.changes) {
          let id: number;
          if (ch.type === "task" && !ch.value.owner && ch.value.kind === "pi.generation" && ch.value.state.status === "terminal") id = Number(ch.value.conversationId);
          else if (ch.type === "submission" && (ch.value.status === "done" || ch.value.status === "unanswered")) id = Number(ch.value.conversationId);
          else continue;
          toNotify.add(id);
          toCheckMembers.add(id);
        }

        if (toNotify.size === 0 && toCheckMembers.size === 0) return;

        queueMicrotask(() => {
          if (this.closed) return;
          for (const id of toNotify) this.track(this.notify(id));
          for (const id of toCheckMembers) this.track(this.members(id));
        });
      },
      end: () => {
        this.closed = true;
        queueMicrotask(() => void this.close());
      },
    });
    const ids = await this.o.harness.commit(async tx => {
      const found: number[] = [];
      let cursor;
      do {
        const page = await tx.scanConversations({}, 100, cursor);
        for (const conv of page.items) if (!conv.owner) for (const m of (await tx.doc(Crew, conv.id)).members) {
          if (!m.stopped && await tx.conversation(m.id as ConversationId)) found.push(m.id);
        }
        cursor = page.next;
      } while (cursor);
      return found;
    }, context).catch(e => { this.o.log(`crew-notify: reconcile failed: ${(e as Error).message}`); return [] as number[]; });
    for (const id of ids) this.track(this.notify(id));
  }

  private track(run: Promise<unknown>) {
    this.inflight.add(run);
    void run.finally(() => this.inflight.delete(run));
  }
  /** A lead turn ended: retry reports previously blocked by its session status. */
  private async members(lead: number) {
    const ids = await this.o.harness.commit(async tx => (await tx.doc(Crew, lead as ConversationId)).members.filter(m => !m.stopped).map(m => m.id), context).catch(() => [] as number[]);
    for (const id of ids) if (!this.closed) await this.notify(id);
  }

  /** One check at a time per member, so the trigger pair (submission and generation end) delivers and logs once. */
  notify(member: number): Promise<boolean> {
    if (this.closed || !Number.isSafeInteger(member) || member < 1) return Promise.resolve(false);
    return withChildControl(member, () => this.deliver(member));
  }

  private async deliver(member: number): Promise<boolean> {
    if (this.closed) return false;
    try {
      const pending = await this.o.harness.commit(tx => inspect(tx, member as ConversationId, this.o.title), context);
      if (this.closed || !pending || this.o.skip?.(Number(pending.lead))) return false;
      const lead = await this.o.harness.conversation(pending.lead, context);
      if (!lead) return false;

      const result = await this.o.harness.commit(async tx => {
        // Dedup before eligibility checks
        const existing = await tx.submissionByRequest(pending.lead, pending.noticeId);
        if (existing) return { kind: "existing" as const, id: existing.id };

        if (this.closed) return { kind: "rejected" as const };
        const conv = await tx.conversation(pending.lead);
        if (!conv || conv.owner) return { kind: "rejected" as const };
        const status = await readSessionStatus(tx, pending.lead, await isRunning(tx, pending.lead));
        if (["stopped", "needs_input", "needs_approval", "failed", "limit_reached"].includes(status.status)) return { kind: "rejected" as const };
        const inspectCheck = await inspect(tx, member as ConversationId, this.o.title);
        if (!inspectCheck || inspectCheck.noticeId !== pending.noticeId) return { kind: "rejected" as const };

        // Transactional submission before any table writes
        const subId = await lead.submit(tx, {
          type: "input", requestId: pending.noticeId, whenBusy: REPORT_WHEN_BUSY, content: pending.content,
          entry: { kind: XSESSION_MSG, data: { from: member, hop: 1, requestId: pending.noticeId } satisfies XSessionMarker },
        });
        return { kind: "admitted" as const, id: subId };
      }, context);

      if (result.kind === "rejected") return false;

      this.o.log(`crew-notify ${member}: ${pending.state} -> session ${pending.lead}`);
      return true;
    } catch (e) {
      if ((e as { name?: string }).name === "ConversationBusy") return false;
      this.o.log(`crew-notify ${member}: ${(e as Error).message}`);
      this.queueRetry(member);
      return false;
    }
  }

  private queueRetry(member: number) {
    if (this.closed) return;
    this.retries.add(member);
    this.retry ??= setTimeout(() => {
      this.retry = undefined;
      const ids = [...this.retries]; this.retries.clear();
      for (const id of ids) this.track(this.notify(id));
    }, 5000);
    this.retry.unref?.();
  }

  async close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retries.clear();
    this.observation?.detach();
    await Promise.allSettled([...this.inflight]);
  }
}
