// Project board: a kanban board per project, shared by the user and by every session in the project.
// Cards live in SQLite next to the projects, so they outlive any one session. The `todo` tool stays the model's
// per-session step list; a session links its steps to a card with todo metadata {cardId}.
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { detectCycle } from "./todo.js";
import { deliverCardEvents, wakeEvents } from "./board-events.js";

export const STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type CardStatus = (typeof STATUSES)[number];
export type CardPriority = (typeof PRIORITIES)[number];
export type Card = {
  id: number; project: number; subject: string; description: string; priority: CardPriority; status: CardStatus;
  blockedBy: number[]; owner: string | null; blocked: string | null; labels: string[]; archived: boolean; created: number; updated: number;
};
export type Activity = { id: number; card: number; at: number; by: string; text: string };
export type CardInput = {
  subject?: unknown; description?: unknown; priority?: unknown; status?: unknown; owner?: unknown; labels?: unknown;
  archived?: unknown; blocked?: unknown; addBlockedBy?: unknown; removeBlockedBy?: unknown; blockedBy?: unknown;
};
export class BoardError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}
const RANK: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
type Row = { id: number; project_id: number; subject: string; description: string; priority: string; status: string; blocked_by: string; owner: string | null; blocked_reason: string | null; labels: string; archived: number; created: number; updated: number };
const toCard = (r: Row): Card => ({
  id: r.id, project: r.project_id, subject: r.subject, description: r.description, priority: r.priority as CardPriority, status: r.status as CardStatus,
  blockedBy: JSON.parse(r.blocked_by), owner: r.owner, blocked: r.blocked_reason, labels: JSON.parse(r.labels), archived: !!r.archived, created: r.created, updated: r.updated,
});
const bad = (m: string): never => { throw new BoardError(400, m); };
const ids = (v: unknown, what: string): number[] => {
  if (!Array.isArray(v) || v.some(n => !Number.isSafeInteger(n) || n < 1)) return bad(`${what} must be an array of card ids`);
  return v as number[];
};

export class BoardStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_board_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog', blocked_by TEXT NOT NULL DEFAULT '[]',
        owner TEXT, labels TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS luna_board_cards_project ON luna_board_cards(project_id);
      CREATE TABLE IF NOT EXISTS luna_board_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS luna_board_activity_card ON luna_board_activity(card_id);`);
    const cols = db.prepare("PRAGMA table_info(luna_board_cards)").all() as { name: string }[];
    if (!cols.some(c => c.name === "blocked_reason")) db.exec("ALTER TABLE luna_board_cards ADD COLUMN blocked_reason TEXT");
  }
  list(project: number, o: { status?: CardStatus; archived?: boolean } = {}): Card[] {
    const rows = this.db.prepare("SELECT * FROM luna_board_cards WHERE project_id=? AND archived=?").all(project, o.archived ? 1 : 0) as Row[];
    return rows.map(toCard).filter(c => !o.status || c.status === o.status)
      .sort((a, b) => RANK[b.priority]! - RANK[a.priority]! || a.id - b.id);
  }
  get(project: number, id: number): Card | undefined {
    const r = this.db.prepare("SELECT * FROM luna_board_cards WHERE project_id=? AND id=?").get(project, id) as Row | undefined;
    return r && toCard(r);
  }
  private need(project: number, id: number): Card {
    const c = this.get(project, id); if (!c) throw new BoardError(404, `card #${id} not found`);
    return c;
  }
  private fields(i: CardInput, cur?: Card) {
    const out: { subject: string; description: string; priority: CardPriority; status: CardStatus; owner: string | null; blocked: string | null; labels: string[]; archived: boolean } = {
      subject: cur?.subject ?? "", description: cur?.description ?? "", priority: cur?.priority ?? "medium", status: cur?.status ?? "backlog",
      owner: cur?.owner ?? null, blocked: cur?.blocked ?? null, labels: cur?.labels ?? [], archived: cur?.archived ?? false,
    };
    if (i.subject !== undefined) {
      if (typeof i.subject !== "string" || !i.subject.trim() || i.subject.trim().length > 200) bad("subject must contain 1 to 200 characters");
      out.subject = (i.subject as string).trim();
    }
    if (!out.subject) bad("subject required");
    if (i.description !== undefined) {
      if (typeof i.description !== "string" || i.description.length > 8000) bad("description must be text of at most 8000 characters");
      out.description = i.description as string;
    }
    if (i.priority !== undefined) { if (!PRIORITIES.includes(i.priority as never)) bad(`priority must be one of ${PRIORITIES.join(", ")}`); out.priority = i.priority as CardPriority; }
    if (i.status !== undefined) { if (!STATUSES.includes(i.status as never)) bad(`status must be one of ${STATUSES.join(", ")}`); out.status = i.status as CardStatus; }
    if (i.owner !== undefined) {
      if (i.owner !== null && (typeof i.owner !== "string" || i.owner.length > 100)) bad("owner must be text of at most 100 characters");
      out.owner = (i.owner as string | null)?.trim() || null;
    }
    if (i.blocked !== undefined) {
      if (i.blocked !== null && (typeof i.blocked !== "string" || i.blocked.length > 500)) bad("blocked must be a reason of at most 500 characters, or empty to clear");
      out.blocked = (i.blocked as string | null)?.trim() || null;
    }
    if (i.labels !== undefined) {
      if (!Array.isArray(i.labels) || i.labels.length > 20 || i.labels.some(l => typeof l !== "string" || !l.trim() || l.length > 40)) bad("labels must be up to 20 texts of 1 to 40 characters");
      out.labels = [...new Set((i.labels as string[]).map(l => l.trim()))];
    }
    if (i.archived !== undefined) { if (typeof i.archived !== "boolean") bad("archived must be a boolean"); out.archived = i.archived as boolean; }
    return out;
  }
  /** Validate a dependency list against the project's cards. */
  private blockers(project: number, id: number | undefined, next: number[]) {
    for (const dep of next) {
      if (dep === id) bad(`card #${id} cannot block itself`);
      if (!this.get(project, dep)) bad(`blockedBy: #${dep} not found`);
    }
    if (id !== undefined) {
      const all = [...this.list(project), ...this.list(project, { archived: true })].map(c => ({ id: c.id, blockedBy: c.blockedBy }));
      if (detectCycle(all as never, id, next)) bad("blockedBy would create a cycle");
    }
  }
  create(project: number, i: CardInput): Card {
    const f = this.fields(i);
    const blocked = i.blockedBy === undefined ? [] : [...new Set(ids(i.blockedBy, "blockedBy"))];
    this.blockers(project, undefined, blocked);
    const now = Date.now();
    const r = this.db.prepare(`INSERT INTO luna_board_cards(project_id,subject,description,priority,status,blocked_by,owner,labels,archived,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(project, f.subject, f.description, f.priority, f.status, JSON.stringify(blocked), f.owner, JSON.stringify(f.labels), Number(f.archived), now, now);
    const made = this.need(project, Number(r.lastInsertRowid));
    this.log(made.id, "user", `created in ${made.status}`);
    return made;
  }
  /** Append one line to a card's activity log. */
  log(card: number, by: string, text: string) {
    this.db.prepare("INSERT INTO luna_board_activity(card_id,at,by,text) VALUES (?,?,?,?)").run(card, Date.now(), by, text.slice(0, 600));
  }
  /** Newest first. */
  activity(project: number, id: number, limit = 50): Activity[] {
    this.need(project, id);
    return (this.db.prepare("SELECT id,card_id,at,by,text FROM luna_board_activity WHERE card_id=? ORDER BY id DESC LIMIT ?").all(id, limit) as { id: number; card_id: number; at: number; by: string; text: string }[])
      .map(r => ({ id: r.id, card: r.card_id, at: r.at, by: r.by, text: r.text }));
  }
  /** `actor` is the agent session ("session N"). Without it the change is a user change. */
  update(project: number, id: number, i: CardInput, actor?: string): Card {
    const cur = this.need(project, id);
    const f = this.fields(i, cur);
    let blocked = [...cur.blockedBy];
    if (i.blockedBy !== undefined) blocked = [...new Set(ids(i.blockedBy, "blockedBy"))];
    if (i.removeBlockedBy !== undefined) { const rm = new Set(ids(i.removeBlockedBy, "removeBlockedBy")); blocked = blocked.filter(d => !rm.has(d)); }
    if (i.addBlockedBy !== undefined) for (const d of ids(i.addBlockedBy, "addBlockedBy")) if (!blocked.includes(d)) blocked.push(d);
    if (JSON.stringify(blocked) !== JSON.stringify(cur.blockedBy)) this.blockers(project, id, blocked);
    // A card moved into progress without an owner belongs to whoever moved it.
    if (actor && f.status === "in_progress" && cur.status !== "in_progress" && !f.owner && i.owner === undefined) f.owner = actor;
    // Done or archived releases the owner, unless the same change sets one by hand.
    if (i.owner === undefined && ((f.status === "done" && cur.status !== "done") || (f.archived && !cur.archived))) f.owner = null;
    this.db.prepare(`UPDATE luna_board_cards SET subject=?,description=?,priority=?,status=?,blocked_by=?,owner=?,blocked_reason=?,labels=?,archived=?,updated=? WHERE id=? AND project_id=?`)
      .run(f.subject, f.description, f.priority, f.status, JSON.stringify(blocked), f.owner, f.blocked, JSON.stringify(f.labels), Number(f.archived), Date.now(), id, project);
    const by = actor ?? "user";
    if (cur.status !== f.status) this.log(id, by, `moved ${cur.status} -> ${f.status}`);
    if (cur.archived !== f.archived) this.log(id, by, f.archived ? "archived" : "restored");
    if (cur.owner !== f.owner) this.log(id, by, `owner ${cur.owner ?? "none"} -> ${f.owner ?? "none"}`);
    if (cur.blocked !== f.blocked) this.log(id, by, f.blocked ? `blocked: ${f.blocked}` : "unblocked");
    return this.need(project, id);
  }
  /** Drop an owner whose session no longer exists. */
  clearOwner(project: number, id: number, owner: string) {
    this.db.prepare("UPDATE luna_board_cards SET owner=NULL WHERE id=? AND project_id=? AND owner=?").run(id, project, owner);
  }
  /** User-only: the model archives. */
  delete(project: number, id: number) {
    this.need(project, id);
    const all = [...this.list(project), ...this.list(project, { archived: true })];
    // Other cards stop waiting on a removed card.
    for (const c of all) if (c.blockedBy.includes(id)) this.db.prepare("UPDATE luna_board_cards SET blocked_by=? WHERE id=?").run(JSON.stringify(c.blockedBy.filter(d => d !== id)), c.id);
    this.db.prepare("DELETE FROM luna_board_cards WHERE id=? AND project_id=?").run(id, project);
    this.db.prepare("DELETE FROM luna_board_activity WHERE card_id=?").run(id);
  }
  deleteProject(project: number) {
    this.db.prepare("DELETE FROM luna_board_activity WHERE card_id IN (SELECT id FROM luna_board_cards WHERE project_id=?)").run(project);
    this.db.prepare("DELETE FROM luna_board_cards WHERE project_id=?").run(project);
  }
  /** Compact text for the prompt: column counts and the cards that need attention. Never the whole board. */
  summary(project: number, name: string, cwd: string): string {
    const cards = this.list(project);
    const count = Object.fromEntries(STATUSES.map(s => [s, cards.filter(c => c.status === s).length]));
    const open = cards.filter(c => c.status === "in_progress" || c.status === "review" || (c.status !== "done" && RANK[c.priority]! >= 2)).slice(0, 8);
    const done = new Set(cards.filter(c => c.status === "done").map(c => c.id));
    const clip = (s: string) => (s.length > 80 ? s.slice(0, 77) + "..." : s).replace(/\s+/g, " ");
    const lines = open.map(c => {
      const waits = c.blockedBy.filter(d => !done.has(d));
      return `#${c.id} [${c.status}|${c.priority}] ${clip(c.subject)}${c.owner ? ` (${clip(c.owner)})` : ""}${waits.length ? ` waits on ${waits.map(d => "#" + d).join(",")}` : ""}`;
    });
    return [`Project "${clip(name)}"${cwd ? ` (working directory ${cwd})` : ""}. Board: ${STATUSES.map(s => `${s} ${count[s]}`).join(", ")}.`,
      ...(lines.length ? ["Cards in progress, in review, or high priority:", ...lines] : []),
      "Use the board tool to list, read, create, move, or archive cards. Plan the steps of a card with the todo tool and pass metadata {cardId}."].join("\n");
  }
  /** Full details for `#<id>` mentions in user messages so referenced cards are always in context. */
  mentioned(project: number, ids: Iterable<number>): string {
    const out: string[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id) || !Number.isSafeInteger(id) || id < 1) continue;
      seen.add(id);
      const c = this.get(project, id);
      if (c) out.push(detail(c));
    }
    return out.length ? ["Referenced board items:", ...out].join("\n") : "";
  }
}

const Params = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("create"), Type.Literal("update"), Type.Literal("archive")]),
  id: Type.Optional(Type.Number({ description: "Card id (get, update, archive)" })),
  subject: Type.Optional(Type.String({ description: "Card name (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form description" })),
  priority: Type.Optional(Type.Union(PRIORITIES.map(p => Type.Literal(p)), { description: "low, medium (default), high, or urgent" })),
  status: Type.Optional(Type.Union(STATUSES.map(s => Type.Literal(s)), { description: "Column: backlog (default), todo, in_progress, review, done. With list it filters." })),
  owner: Type.Optional(Type.String({ description: "Who works on the card. Moving a card to in_progress sets it to this session when empty." })),
  blocked: Type.Optional(Type.String({ description: "update: you cannot continue without the user. Short reason, e.g. 'needs your decision on X'. The board shows it; the user's answer arrives as a message. Empty string clears it." })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Replace the card's labels" })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Card ids this card waits on (create)" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Add dependencies (update)" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Remove dependencies (update)" })),
  includeArchived: Type.Optional(Type.Boolean({ description: "list: show archived cards instead of active ones" })),
});

const line = (c: Card) => `#${c.id} [${c.status}|${c.priority}${c.archived ? "|archived" : ""}] ${c.subject}${c.owner ? ` (${c.owner})` : ""}${c.blocked ? ` BLOCKED: ${c.blocked}` : ""}${c.blockedBy.length ? ` waits on ${c.blockedBy.map(d => "#" + d).join(",")}` : ""}${c.labels.length ? ` {${c.labels.join(",")}}` : ""}`;
const detail = (c: Card) => [line(c), ...(c.description ? [`  description: ${c.description}`] : []), `  updated: ${new Date(c.updated).toISOString()}`].join("\n");

export function extractMentionedCardIds(messages: readonly { role?: string; content?: unknown }[]): number[] {
  const ids: number[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((b: { type?: string; text?: string }) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n")
        : "";
    if (!text || text.startsWith("<goal_continuation ")) continue;
    for (const match of text.matchAll(/(?:^|[^\w/])#([1-9]\d*)\b/g)) {
      const id = Number(match[1]);
      if (Number.isSafeInteger(id) && id > 0 && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

const DESCRIPTION = [
  "The project board: a kanban board shared by the user and every session in this project. Actions: list, get, create, update, archive.",
  "Columns: backlog, todo, in_progress, review, done. Priorities: low, medium, high, urgent.",
  "- Look at the board before you start project work. Move a card to in_progress when you begin and to review or done when you finish.",
  "- Create cards for work you find that you will not do now. The user sees the board live.",
  "- You can archive a card but you cannot delete it. Use update with archived:false to restore.",
  "- Use the todo tool for the steps inside one card, and pass metadata {cardId} to link them.",
].join("\n");

type Conversations = { projects: { projectOf(conversationId: number): number | undefined; get(id: number): { id: number; name: string; cwd: string } | undefined }; board: BoardStore; touch(): void };

/** Extension: the `board` tool and a compact `board` prompt section. Unlinked chat sessions use General. */
export function createBoardExtension(conversations: () => Conversations | undefined) {
  return defineExtension({
    name: "board",
    tools: [defineTool({
      name: "board",
      description: DESCRIPTION,
      parameters: Params,
      execute: async (a, api, context) => {
        const text = (t: string, isError = false) => ({ output: [{ type: "text" as const, text: t }], isError });
        const conv = conversations();
        const pid = conv?.projects.projectOf(Number(api.conversationId));
        if (!conv || pid === undefined || !conv.projects.get(pid)) return text("Error: this session is not in a project, or the project was deleted.", true);
        const board = conv.board, actor = `session ${api.conversationId}`;
        let wakes: ReturnType<typeof wakeEvents> = [];
        try {
          const out = await api.commit(async () => {
            switch (a.action) {
              case "list": {
                const cards = board.list(pid, { ...(a.status ? { status: a.status } : {}), archived: a.includeArchived === true });
                return cards.length ? cards.map(line).join("\n") : "No cards";
              }
              case "get": { const c = a.id === undefined ? bad("id required for get") : board.get(pid, a.id); return c ? detail(c) : `Error: card #${a.id} not found`; }
              case "create": { const c = board.create(pid, a); conv.touch(); return `Created #${c.id}: ${c.subject} (${c.status}, ${c.priority})`; }
              case "update": {
                if (a.id === undefined) bad("id required for update");
                const { id, action, includeArchived, ...changes } = a;
                const before = board.get(pid, id!);
                const c = board.update(pid, id!, changes, actor); conv.touch();
                if (before) wakes = wakeEvents(board, pid, before, c);
                return `Updated #${c.id} [${c.status}|${c.priority}]`;
              }
              case "archive": { if (a.id === undefined) bad("id required for archive"); const c = board.update(pid, a.id!, { archived: true }); conv.touch(); return `Archived #${c.id}`; }
            }
          }, context);
          // A finished card wakes the owners of cards that waited on it. Delivery follows the commit.
          if (wakes.length) await deliverCardEvents({ conversation: (id: never, ctx: never) => api.conversation(id, ctx) } as never, wakes);
          return text(out);
        } catch (e) {
          if (e instanceof BoardError) return text("Error: " + e.message, true);
          throw e;
        }
      },
    })],
    sections: [section("board", async (input, context) => {
      const conv = conversations();
      const pid = conv?.projects.projectOf(Number(input.conversationId));
      const p = pid === undefined ? undefined : conv!.projects.get(pid);
      if (!p) return undefined;
      const base = conv!.board.summary(p.id, p.name, p.cwd);
      const runtime = input.read as { context?: (id: typeof input.conversationId, ctx: typeof context) => Promise<{ messages: readonly { role?: string; content?: unknown }[] }> };
      const view = typeof runtime.context === "function" ? await runtime.context(input.conversationId, context).catch(() => undefined) : undefined;
      const mentioned = view ? conv!.board.mentioned(p.id, extractMentionedCardIds(view.messages)) : "";
      return mentioned ? `${base}\n\n${mentioned}` : base;
    })],
  });
}
