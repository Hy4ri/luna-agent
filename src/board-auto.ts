// Automatic card runs. A card with auto on, owner "agent", status todo, no open blockers, and no block reason
// gets its own project session. The run claims the card (owner "session N", in_progress), works toward a goal built from the card,
// and moves the card to done or review. When it cannot continue, the card shows a block reason and the run waits for the user.
// State lives on the card and in the session (GoalDoc); this module keeps no store of its own.
import type { ConversationId, Extension, Tx } from "@earendil-works/pi-durable";
import { AUTO_OWNER, type BoardStore, type Card } from "./board.js";
import { ownerSession } from "./board-events.js";
import { GoalDoc, type Goal } from "./goal-doc.js";
import { context } from "./luna.js";
import { createPlannedSession, linkProject, planSession, type SessionDeps } from "./session-create.js";
import { isRunning, readSessionStatus, type SessionStatus } from "./session-status.js";

type Harness = Awaited<ReturnType<typeof import("./luna.js").openLuna>>;
type Conversations = {
  board: BoardStore;
  projects: { list(): { id: number }[]; projectOf(id: number): number | undefined; get(id: number): { id: number; name: string } | undefined };
  exists(id: number): boolean;
  update(id: number, patch: { title?: string }): unknown;
  touch(): void;
};
export type BoardAutoPolicy = { maxConcurrent: number; tokenBudget: number; maxRuns: number };

const PRIORITY = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
const ACTIVE = new Set<SessionStatus>(["running", "reviewing"]);

/** A card that may start now. `done` holds the ids of done cards in its project. */
export function armed(c: Card, done: ReadonlySet<number>): boolean {
  return !!c.auto && c.status === "todo" && c.owner === AUTO_OWNER && !c.archived && !c.blocked && c.blockedBy.every(d => done.has(d));
}

/** A card an automatic run works on now. A blocked run waits for the user and frees its slot. */
export function working(c: Card): boolean {
  return !!c.auto && c.status === "in_progress" && ownerSession(c.owner) !== undefined && !c.archived && !c.blocked;
}

/** The first input of a card run. It is the whole brief: the session has no user to ask. */
export function autoBrief(c: Card, project: string): string {
  const files = c.attachments.map(a => `${a.name} (${a.type}, ${a.size} bytes)`).join(", ");
  return [
    `[automatic board run] You work on board card #${c.id} in project "${project}". Nobody watches this session. Do not wait for a user and do not ask questions: ask_user_question is not available here.`,
    "",
    `<card id="${c.id}" priority="${c.priority}"${c.labels.length ? ` labels="${c.labels.join(",")}"` : ""}>`,
    `Subject: ${c.subject}`,
    ...(c.description ? ["", c.description] : []),
    ...(files ? ["", `Attachments (on the card, not in this session): ${files}`] : []),
    "</card>",
    "",
    "Rules:",
    "- The active goal holds this card. Set a short task plan with goal set_tasks, do the work, verify it with real commands, then complete the goal.",
    "- If the project uses auto-worktree, start a session worktree before your first edit. Commit on the session branch.",
    "- Merge, publish, release, deploy, spend money, delete data, or contact people only when the card description explicitly says so. Otherwise leave that step undone.",
    "- When the work is done and verified, move the card with the board tool: to done when nothing is left, to review when a step needs the user (for example a merge the card does not authorize). Say what is left in the card or your final answer.",
    "- When you cannot continue without the user (missing decision, credential, permission, broken environment), or something urgent comes up: update the card with blocked set to a short reason, pause the goal with the same reason, and end your turn. Do not guess.",
    "- The user's answer to a blocked card arrives as a board event. Then resume the goal (goal update status=active) and continue.",
  ].join("\n");
}

export class BoardAutoRunner {
  private chain: Promise<void> = Promise.resolve();
  private readonly last = new Map<number, SessionStatus>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private observation?: { detach(): void };
  private unsubscribe?: () => void;
  private closed = false;

  constructor(private readonly o: {
    harness: Harness;
    conversations: Conversations;
    /** Rules for a new session; undefined while the runtime starts. */
    session: () => SessionDeps | undefined;
    policy: () => BoardAutoPolicy;
    /** Extensions an unattended session must not have (ask_user_question). */
    exclude?: readonly Extension[];
    /** Whether the goal extension runs. Without it a card gets one run. */
    goal?: boolean;
    log?: (msg: string) => void;
    debounceMs?: number;
  }) {}

  /** Subscribe to board changes and session commits, then start every armed card. */
  start() {
    this.unsubscribe = this.o.conversations.board.onChange(p => this.kick(p));
    this.observation = this.o.harness.observeCommits({
      advance: p => {
        for (const ch of p.changes) {
          if (ch.type === "entry") continue;
          const id = ch.type === "conversation" ? ch.value.id : ch.type === "task" || ch.type === "submission" ? ch.value.conversationId : ch.conversationId;
          if (id !== undefined) this.schedule(Number(id));
        }
      },
      end: () => { this.closed = true; },
    });
    for (const p of this.o.conversations.projects.list()) this.kick(p.id, true);
  }

  /** Queue a scan of one project. Scans run one at a time, so a card never starts twice. */
  kick(project: number, recover = false) {
    if (this.closed) return;
    this.chain = this.chain.then(() => this.scan(project, recover)).catch(e => this.o.log?.(`board auto: ${(e as Error).message}`));
  }

  /** Wait for queued scans (tests). */
  idle() { return this.chain; }

  private async scan(project: number, recover: boolean) {
    const board = this.o.conversations.board, all = board.list(project);
    // After a restart, a run that ended while the daemon was down still needs its card updated.
    if (recover) for (const c of all.filter(working)) {
      const id = ownerSession(c.owner)!;
      const st = await this.status(id);
      if (st && !ACTIVE.has(st.status)) await this.settle(project, c, id, st.status, st.statusReason);
      else if (st) this.last.set(id, st.status);
    }
    const done = new Set(all.filter(c => c.status === "done").map(c => c.id));
    let slots = this.o.policy().maxConcurrent - board.list(project).filter(working).length;
    const ready = board.list(project).filter(c => armed(c, done)).sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority] || a.id - b.id);
    for (const c of ready) {
      if (slots <= 0 || this.closed) break;
      if (await this.launch(project, c)) slots--;
    }
  }

  private async block(project: number, card: number, reason: string, actor: string) {
    const conv = this.o.conversations;
    await this.o.harness.commit(async () => conv.board.update(project, card, { blocked: reason.slice(0, 500) }, actor), context);
    conv.touch();
  }

  /** Create the card's session, claim the card, and send the brief. Returns false when the card could not start. */
  private async launch(project: number, card: Card): Promise<boolean> {
    const conv = this.o.conversations, deps = this.o.session(), auto = card.auto!;
    if (!deps) return false;
    const slash = auto.model?.indexOf("/") ?? -1;
    let plan;
    try {
      plan = planSession(deps, {
        project,
        ...(auto.model && slash > 0 ? { model: { provider: auto.model.slice(0, slash), modelId: auto.model.slice(slash + 1) } } : {}),
        ...(auto.thinking ? { thinkingLevel: auto.thinking } : {}),
      });
    } catch (e) {
      await this.block(project, card.id, `Auto run cannot start: ${(e as Error).message}`, "auto");
      return false;
    }
    if (this.o.exclude?.length) {
      const ext = plan.agent.extensions;
      const add = ext && !Array.isArray(ext) && "add" in ext ? (ext as { add?: readonly Extension[] }).add : undefined;
      plan = { ...plan, agent: { ...plan.agent, extensions: { ...(add ? { add } : {}), remove: this.o.exclude } } };
    }
    const policy = this.o.policy(), useGoal = this.o.goal !== false;
    const id = await this.o.harness.commit(async (tx: Tx) => {
      const id = await createPlannedSession(tx, plan);
      if (useGoal) {
        const d = await tx.doc(GoalDoc, id);
        d.seq += 1;
        const g: Goal = {
          id: `g${d.seq}`, objective: `Board card #${card.id}: ${card.subject}${card.description ? `\n\n${card.description.slice(0, 4000)}` : ""}`,
          mode: "regular", status: "active", tasks: [], audit: true, runs: 0, maxRuns: policy.maxRuns,
          verificationContract: "The card's requirements are met and verified with real commands or evidence, and the card is moved to done or review.",
          tokenBudget: policy.tokenBudget, baseTokens: 0, tokensUsed: 0, created: Date.now(),
        };
        d.goal = g as never;
      }
      return id;
    }, context);
    const sid = Number(id), actor = `session ${sid}`;
    linkProject(deps.projects, sid, plan);
    await conv.update(sid, { title: `#${card.id} ${card.subject}`.slice(0, 120) });
    // Claim in one write: a claimed card is no longer armed, so a later scan cannot start it again.
    await this.o.harness.commit(async () => conv.board.update(project, card.id, { status: "in_progress", owner: actor }, actor), context);
    conv.board.log(card.id, actor, `auto run started (${auto.model ?? "default model"}${auto.thinking ? `, ${auto.thinking}` : ""})`);
    conv.touch();
    this.last.set(sid, "running");
    try {
      const session = await this.o.harness.conversation(id as ConversationId, context);
      if (!session) throw new Error("session not found");
      await session.submit({ type: "input", content: autoBrief(card, conv.projects.get(project)?.name ?? `#${project}`), requestId: `board-auto:${card.id}:${card.updated}` }, context);
    } catch (e) {
      await this.block(project, card.id, `Auto run did not start: ${(e as Error).message}`, actor);
    }
    this.o.log?.(`board auto: card #${card.id} started in session ${sid}`);
    return true;
  }

  private status(id: number) {
    if (!this.o.conversations.exists(id)) return Promise.resolve(undefined);
    return this.o.harness.commit(async (tx: Tx) => readSessionStatus(tx, id as unknown as ConversationId, await isRunning(tx, id as unknown as ConversationId)), context);
  }

  private schedule(id: number) {
    if (this.closed || this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.check(id).catch(e => this.o.log?.(`board auto: ${(e as Error).message}`));
    }, this.o.debounceMs ?? 1000));
  }

  /** The card that session `id` runs automatically, if any. */
  private cardOf(id: number): { project: number; card: Card } | undefined {
    const project = this.o.conversations.projects.projectOf(id);
    if (project === undefined) return undefined;
    const card = this.o.conversations.board.list(project).find(c => !!c.auto && c.status === "in_progress" && ownerSession(c.owner) === id);
    return card && { project, card };
  }

  private async check(id: number) {
    if (this.closed) return;
    const run = this.cardOf(id);
    if (!run) { this.last.delete(id); return; }
    const st = await this.status(id);
    if (!st) return;
    const was = this.last.get(id);
    this.last.set(id, st.status);
    if (!was || !ACTIVE.has(was) || ACTIVE.has(st.status)) return;
    await this.settle(run.project, run.card, id, st.status, st.statusReason);
  }

  /** A run stopped working. Keep the card honest: done or review when the goal is complete, otherwise a block reason. */
  private async settle(project: number, card: Card, id: number, status: SessionStatus, reason: string | null) {
    if (card.blocked || card.status !== "in_progress") return;
    const actor = `session ${id}`;
    const goal = this.o.goal === false ? undefined : (await this.o.harness.commit(async (tx: Tx) => (await tx.doc(GoalDoc, id as unknown as ConversationId)).goal, context)) as Goal | null | undefined;
    const ended = status === "finished" || status === "ready" || status === "review_finished";
    if (ended && (this.o.goal === false || goal?.status === "complete")) {
      // The goal is complete but the card was left in progress: the user reviews it.
      await this.o.harness.commit(async () => this.o.conversations.board.update(project, card.id, { status: "review" }, actor), context);
      this.o.conversations.board.log(card.id, actor, "auto run finished; card moved to review");
      this.o.conversations.touch();
      return;
    }
    const why = status === "needs_input" || status === "needs_approval" ? `Needs ${status === "needs_input" ? "input" : "approval"}: ${reason ?? "the run asked for the user"}`
      : status === "failed" ? `Run failed: ${reason ?? "unknown error"}`
      : status === "limit_reached" ? `Limit reached: ${reason ?? "the run hit a limit"}`
      : status === "stopped" ? `Run stopped: ${reason ?? "stopped"}`
      : goal && goal.status !== "complete" && goal.status !== "active" ? `Goal ${goal.status}: ${goal.statusReason ?? "no reason given"}`
      : "The run ended before the goal was complete.";
    await this.block(project, card.id, why, actor);
  }

  async close() {
    this.closed = true;
    this.unsubscribe?.();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.observation?.detach();
    await this.chain.catch(() => {});
  }
}
