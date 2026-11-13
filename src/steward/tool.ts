// The `steward` agent tool. The daily luna-steward cron job uses it to read what Steward already filed and to file model-found cards.
import { Type, type Static } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { StringEnum } from "../string-enum.js";
import type { StewardService } from "./service.js";
import { DISMISS_REASONS, STEWARD_STATUSES, type NewSuggestion, type Suggestion } from "./store.js";
import type { ConversationStore } from "../conversations.js";
import { StewardError } from "./service.js";
import { cancelQuestions, changeGoal, clearStatus, finishTodos, viewSession } from "./session-ops.js";
import { TipSchema } from "./tips.js";

const KINDS = ["skill", "memory", "feature_tip", "new_project", "new_rule", "rule_idea", "reminder_unscheduled"] as const;
const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

const CARD_ACTIONS = ["agree", "dismiss", "snooze"] as const;
const SESSION_ACTIONS = ["session", "todos_done", "cancel_questions", "clear_status", "goal", "edit_session"] as const;
const Params = Type.Object({
  action: StringEnum(["list", "suggest", "scan", ...CARD_ACTIONS, ...SESSION_ACTIONS], { description: "list: cards with id, evidence and payload. suggest: file one new card. scan: run the detectors now. agree, dismiss, snooze: act on the cards in ids. session: show a session's open todos, questions, goal and status. todos_done, cancel_questions, clear_status, goal, edit_session: clean up that session." }),
  status: Type.Optional(StringEnum(STEWARD_STATUSES, { description: "list: only cards with this status." })),
  ids: Type.Optional(Type.Array(Type.Number(), { description: "agree, dismiss, snooze: card ids the user named." })),
  confirm: Type.Optional(Type.Boolean({ description: "agree: true only after the user confirmed a delete or remove card by id." })),
  targets: Type.Optional(Type.Array(Type.Number(), { description: "agree on a batch card: only these session ids." })),
  reason: Type.Optional(StringEnum(DISMISS_REASONS, { description: "dismiss (required): wrong, not_now (snooze 30 days), already_done, dont_care_kind, too_aggressive." })),
  note: Type.Optional(Type.String({ description: "dismiss: the user's words. cancel_questions: note to the waiting session. goal: reason." })),
  days: Type.Optional(Type.Number({ description: "snooze: 1 to 365." })),
  session: Type.Optional(Type.Number({ description: "scan: one session. session actions: the target session id the user named." })),
  todo_ids: Type.Optional(Type.Array(Type.Number(), { description: "todos_done: todo ids to mark completed." })),
  all: Type.Optional(Type.Boolean({ description: "todos_done: true marks every open todo completed." })),
  goal: Type.Optional(StringEnum(["pause", "complete", "clear"], { description: "goal: what to do with the session's goal." })),
  title: Type.Optional(Type.String({ description: "suggest: short title. edit_session: new session title." })),
  archived: Type.Optional(Type.Boolean({ description: "edit_session: archive or unarchive." })),
  pinned: Type.Optional(Type.Boolean({ description: "edit_session: pin or unpin." })),
  project: Type.Optional(Type.Number({ description: "edit_session: move the session to this project id." })),
  kind: Type.Optional(StringEnum(KINDS, { description: "suggest: card kind." })),
  body: Type.Optional(Type.String({ description: "suggest: why, in one or two sentences." })),
  evidence: Type.Optional(Type.Array(Type.Object({ sessionId: Type.Number(), note: Type.String() }), { description: "suggest: sessions that show the pattern. Each must exist." })),
  payload: Type.Optional(Type.Object({}, { additionalProperties: true, description: "memory: {key?, content}. skill: {name, existing?, outline}. new_project: {name, cwd, worker, sessionIds}. feature_tip: {}. new_rule: {tip:{id,title,body,when:{tool,minCalls,minSessions,withinDays,withoutTool?,kind?:tool|skill|compaction}}}. rule_idea (a rule that needs data Steward lacks): {idea}. reminder_unscheduled: {sessionId, content, dueAt (epoch ms, future)}." })),
});
type Args = Static<typeof Params>;

/** Check a model card at the boundary. Returns the card, or an error text. */
export function buildCard(a: Args, sessionExists: (id: number) => boolean): NewSuggestion | string {
  if (!a.kind || !a.title?.trim() || !a.body?.trim()) return "suggest needs kind, title and body";
  const evidence = a.evidence ?? [];
  if (!evidence.length) return "suggest needs at least one evidence session";
  for (const e of evidence) if (!Number.isSafeInteger(e.sessionId) || !sessionExists(e.sessionId)) return `evidence session ${e.sessionId} does not exist`;
  const p = (a.payload ?? {}) as Record<string, unknown>;
  let key: string;
  if (a.kind === "memory") {
    if (typeof p.content !== "string" || !p.content.trim()) return "memory payload needs content";
    if (p.key !== undefined && typeof p.key !== "string") return "memory payload key must be a string";
    key = slug(String(p.key ?? a.title));
  } else if (a.kind === "skill") {
    if (typeof p.name !== "string" || !slug(p.name)) return "skill payload needs name";
    if (typeof p.outline !== "string" || !p.outline.trim()) return "skill payload needs outline";
    key = slug(p.name);
  } else if (a.kind === "new_project") {
    if (typeof p.name !== "string" || typeof p.cwd !== "string" || !Array.isArray(p.sessionIds) || !p.sessionIds.every(Number.isSafeInteger)) return "new_project payload needs name, cwd, worker, sessionIds";
    key = slug(p.name);
  } else if (a.kind === "new_rule") {
    const t = TipSchema.safeParse({ ...(p.tip as object), status: "shadow" });
    if (!t.success) return `new_rule payload.tip is not valid: ${t.error.issues[0]?.message}`;
    key = t.data.id;
  } else if (a.kind === "rule_idea") {
    if (typeof p.idea !== "string" || !p.idea.trim()) return "rule_idea payload needs idea";
    key = slug(a.title);
  } else if (a.kind === "reminder_unscheduled") {
    if (!Number.isSafeInteger(p.sessionId) || !sessionExists(p.sessionId as number)) return "reminder payload needs an existing sessionId";
    if (typeof p.content !== "string" || !p.content.trim() || p.content.startsWith("/")) return "reminder payload needs plain content";
    if (typeof p.dueAt !== "number" || !(p.dueAt > Date.now())) return "reminder payload needs a future dueAt";
    key = slug(`${p.sessionId}-${p.content}`);
  } else key = slug(a.title);
  if (!key) return "title or name gives an empty id";
  return { kind: a.kind, fingerprint: `${a.kind}:${key}`, title: a.title.trim().slice(0, 120), body: a.body.trim().slice(0, 1000), evidence: evidence.map(e => ({ sessionId: e.sessionId, note: e.note.slice(0, 200) })),
    payload: a.kind === "new_project" ? { worker: "main", ...p } : p, source: "model", ruleId: `model:${a.kind}` };
}

/** One card in full: what list shows, so a session can go through the cards with the user. */
export function cardText(c: Suggestion): string {
  const lines = [`#${c.id} ${c.fingerprint} [${c.status}] ${c.title}`];
  if (c.status === "open" || c.status === "snoozed") {
    lines.push(`  ${c.body}`);
    for (const e of c.evidence) lines.push(`  evidence: session ${e.sessionId}: ${e.note}`);
    if (Object.keys(c.payload).length) lines.push(`  payload: ${JSON.stringify(c.payload).slice(0, 1500)}`);
  }
  return lines.join("\n");
}

export interface StewardToolDeps {
  steward: () => StewardService | undefined;
  sessionExists: (id: number) => boolean;
  conversations?: () => ConversationStore | undefined;
  /** Archiving a session cancels its scheduled messages, as the web UI does. */
  onArchive?: (id: number) => Promise<unknown>;
}

const DESCRIPTION = [
  "Steward suggestion cards and session housekeeping.",
  "list shows cards with id, body, evidence and payload; it also stops you from filing a card again. suggest files one card (kind skill, memory, feature_tip, new_project, new_rule, reminder_unscheduled) with evidence sessions. scan runs the detectors now.",
  "agree, dismiss and snooze act on card ids. Act only on the ids the user named, never on all cards. dismiss needs a reason. A delete_session or worktree_orphan card needs confirm:true, and only after the user confirmed that card.",
  "session shows a session's open todos, unanswered questions, goal and status. todos_done, cancel_questions, clear_status, goal (pause, complete, clear) and edit_session (title, archived, pinned, project) change that session without a message to it. Use them only on sessions the user named.",
].join(" ");

export function createStewardExtension(depsOrSteward: StewardToolDeps | (() => StewardService | undefined), exists?: (id: number) => boolean) {
  const d: StewardToolDeps = typeof depsOrSteward === "function" ? { steward: depsOrSteward, sessionExists: exists! } : depsOrSteward;
  const stewardTool = defineTool({
      name: "steward",
      description: DESCRIPTION,
      parameters: Params,
      execute: async (a: Args, api, ctx) => {
        const w = d.steward();
        if (!w) return text("Error: Steward is disabled.", true);
        const fail = (e: unknown) => text(`Error: ${(e as Error).message}`, true);
        if (a.action === "list") {
          w.store.expireSnoozed();
          const rows = w.store.list(a.status).filter(c => a.status || c.status !== "done" || c.source === "model");
          return text(rows.length ? rows.map(cardText).join("\n") : "(no cards)");
        }
        if (a.action === "scan") {
          if (a.session !== undefined && !d.sessionExists(a.session)) return text(`Error: session ${a.session} does not exist`, true);
          try {
            const r = w.scan({ session: a.session, manual: true });
            return text(a.session !== undefined ? `${r.matched} open cards about session ${a.session}.` : `Filed ${r.filed}, showed ${r.shown}, withdrew ${r.withdrawn}, ${r.held} held by the daily limit.`);
          } catch (e) { return fail(e); }
        }
        if ((CARD_ACTIONS as readonly string[]).includes(a.action)) {
          const ids = [...new Set(a.ids ?? [])];
          if (!ids.length) return text(`Error: ${a.action} needs ids`, true);
          if (a.action === "dismiss" && !a.reason) return text("Error: dismiss needs a reason", true);
          if (a.action === "snooze" && a.days === undefined) return text("Error: snooze needs days", true);
          const out: string[] = []; let bad = 0;
          for (const id of ids) {
            try {
              const c = a.action === "agree" ? await w.agree(id, { confirm: a.confirm === true, targets: a.targets })
                : a.action === "dismiss" ? w.dismiss(id, a.reason, a.note) : w.snooze(id, a.days!);
              out.push(`#${id} ${c.status}${c.result ? `: ${c.result}` : ""}`);
            } catch (e) { bad++; out.push(`#${id} error: ${e instanceof StewardError || e instanceof Error ? e.message : String(e)}`); }
          }
          return text(out.join("\n"), bad === ids.length);
        }
        if (a.action === "suggest") {
          const card = buildCard(a, d.sessionExists);
          if (typeof card === "string") return text(`Error: ${card}`, true);
          const known = w.store.has(card.fingerprint);
          const verdict = w.admit(card);
          if (verdict === "skip") return text(`Skipped ${card.fingerprint}: muted or outside the watched projects.`);
          const filed = w.store.file(card, verdict === "show");
          return text(filed ? `${known ? "Refreshed" : "Filed"} ${card.fingerprint}.` : `Skipped ${card.fingerprint}: already handled.`);
        }
        // Session housekeeping.
        const sid = a.session;
        if (sid === undefined || !Number.isSafeInteger(sid)) return text(`Error: ${a.action} needs session`, true);
        if (!d.sessionExists(sid)) return text(`Error: session ${sid} does not exist`, true);
        try {
          switch (a.action) {
            case "session": {
              const v = await api.commit(tx => viewSession(tx, sid), ctx);
              const meta = d.conversations?.()?.get(sid);
              const lines = [`Session ${sid}${meta?.title ? ` "${meta.title}"` : ""}${meta?.archived ? " (archived)" : ""}${meta?.pinned ? " (pinned)" : ""}`];
              lines.push(v.todos.length ? `Open todos:\n${v.todos.map(t => `  ${t.id} [${t.status}] ${t.subject}`).join("\n")}` : "Open todos: none");
              lines.push(v.questions.length ? `Unanswered questions:\n${v.questions.map(q => `  ${q.callId} (${q.purpose}) ${q.question}`).join("\n")}` : "Unanswered questions: none");
              lines.push(v.goal ? `Goal [${v.goal.status}${v.goal.reason ? `: ${v.goal.reason}` : ""}] ${v.goal.objective.slice(0, 300)} (${v.goal.tasksOpen} tasks open)` : "Goal: none");
              lines.push(v.handoff ? `Status: ${v.handoff.status}: ${v.handoff.reason}` : "Status: no handoff");
              return text(lines.join("\n"));
            }
            case "todos_done": {
              if (!a.todo_ids?.length && a.all !== true) return text("Error: todos_done needs todo_ids, or all:true", true);
              const r = await api.commit(tx => finishTodos(tx, sid, a.all === true ? undefined : a.todo_ids), ctx);
              return text(`Completed ${r.done.length ? r.done.join(", ") : "nothing"}.${r.missing.length ? ` Not open: ${r.missing.join(", ")}.` : ""}`, !r.done.length && r.missing.length > 0);
            }
            case "cancel_questions": {
              const n = await api.commit(tx => cancelQuestions(tx, sid, a.note), ctx);
              return text(n ? `Cancelled ${n} question${n === 1 ? "" : "s"}.` : "No unanswered questions.");
            }
            case "clear_status": {
              const had = await api.commit(tx => clearStatus(tx, sid), ctx);
              return text(had ? "Cleared the handoff and marked the session read." : "Marked the session read.");
            }
            case "goal": {
              if (!a.goal) return text("Error: goal needs goal: pause, complete or clear", true);
              const err = await api.commit(tx => changeGoal(tx, sid, a.goal!, a.note), ctx);
              return err ? text(`Error: ${err}`, true) : text(`Goal ${a.goal === "clear" ? "cleared" : a.goal === "pause" ? "paused" : "completed"}.`);
            }
            case "edit_session": {
              const conv = d.conversations?.();
              if (!conv) return text("Error: session management is disabled", true);
              const changes: { title?: string; archived?: boolean; pinned?: boolean } = {};
              if (a.title !== undefined) { const t = a.title.trim(); if (!t || t.length > 200) return text("Error: title must contain 1 to 200 characters", true); changes.title = t; }
              if (a.archived !== undefined) changes.archived = a.archived;
              if (a.pinned !== undefined) changes.pinned = a.pinned;
              if (!Object.keys(changes).length && a.project === undefined) return text("Error: edit_session needs title, archived, pinned or project", true);
              if (a.project !== undefined) await conv.move(sid, a.project);
              if (changes.archived) await d.onArchive?.(sid);
              const m = Object.keys(changes).length ? await conv.update(sid, changes) : conv.get(sid);
              return text(`Session ${sid}: "${m.title ?? ""}"${m.archived ? ", archived" : ""}${m.pinned ? ", pinned" : ""}${a.project !== undefined ? `, project ${a.project}` : ""}.`);
            }
          }
        } catch (e) { return fail(e); }
        return text(`Error: unknown action ${a.action}`, true);
      },
    });
  return defineExtension({
    name: "steward",
    tools: [
      stewardTool,
      // deprecated: remove after next release
      defineTool({ ...stewardTool, name: "wife", description: "Deprecated alias for steward." }),
    ],
  });
}
