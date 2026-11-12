// Project board: a kanban board per project, shared by the user and by every session in the project.
// Cards live in SQLite next to the projects, so they outlive any one session. The `todo` tool stays the model's
// per-session step list; a session links its steps to a card with todo metadata {cardId}.
import type { Database } from "bun:sqlite";
import { Type } from "typebox";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { detectCycle } from "./todo.js";
import { deliverCardEvents, ownerSession, wakeEvents } from "./board-events.js";
import type { UploadStore } from "./uploads.js";
import { StringEnum } from "./string-enum.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./session-create.js";

export const STATUSES = ["backlog", "todo", "in_progress", "review", "done"] as const;
/** Owner text that hands a card to an automatic run. */
export const AUTO_OWNER = "agent";
/** Automatic run settings of a card. null means auto is off. No model or thinking level means the defaults. */
export type CardAuto = { model: string | null; thinking: ThinkingLevel | null };
export const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
export type CardStatus = (typeof STATUSES)[number];
export type CardPriority = (typeof PRIORITIES)[number];
export type Card = {
  id: number; project: number; subject: string; description: string; priority: CardPriority; status: CardStatus;
  blockedBy: number[]; owner: string | null; blocked: string | null; labels: string[]; archived: boolean; created: number; updated: number;
  auto: CardAuto | null;
  attachments: Attachment[];
};
export type Attachment = { id: number; card: number; name: string; type: string; size: number; created: number };
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export type Activity = { id: number; card: number; at: number; by: string; text: string };
export type CardInput = {
  subject?: unknown; description?: unknown; priority?: unknown; status?: unknown; owner?: unknown; labels?: unknown;
  archived?: unknown; blocked?: unknown; addBlockedBy?: unknown; removeBlockedBy?: unknown; blockedBy?: unknown; auto?: unknown;
};
export class BoardError extends Error {
  constructor(readonly status: 400 | 404, message: string) { super(message); }
}
const RANK: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
type Row = { id: number; project_id: number; subject: string; description: string; priority: string; status: string; blocked_by: string; owner: string | null; blocked_reason: string | null; labels: string; archived: number; created: number; updated: number; auto: string | null };
const toCard = (r: Row): Card => ({
  id: r.id, project: r.project_id, subject: r.subject, description: r.description, priority: r.priority as CardPriority, status: r.status as CardStatus,
  blockedBy: JSON.parse(r.blocked_by), owner: r.owner, blocked: r.blocked_reason, labels: JSON.parse(r.labels), archived: !!r.archived, created: r.created, updated: r.updated, auto: r.auto ? JSON.parse(r.auto) : null, attachments: [],
});
type AttachmentRow = { id: number; card_id: number; name: string; type: string; size: number; created: number };
const toAttachment = (r: AttachmentRow): Attachment => ({ id: r.id, card: r.card_id, name: r.name, type: r.type, size: r.size, created: r.created });
const bad = (m: string): never => { throw new BoardError(400, m); };
const ids = (v: unknown, what: string): number[] => {
  if (!Array.isArray(v) || v.some(n => !Number.isSafeInteger(n) || n < 1)) return bad(`${what} must be an array of card ids`);
  return v as number[];
};

export class BoardStore {
  constructor(private readonly db: Database, private readonly uploads?: UploadStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS luna_board_cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, subject TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        priority TEXT NOT NULL DEFAULT 'medium', status TEXT NOT NULL DEFAULT 'backlog', blocked_by TEXT NOT NULL DEFAULT '[]',
        owner TEXT, labels TEXT NOT NULL DEFAULT '[]', archived INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS luna_board_cards_project ON luna_board_cards(project_id);
      CREATE TABLE IF NOT EXISTS luna_board_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, at INTEGER NOT NULL, by TEXT NOT NULL, text TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS luna_board_activity_card ON luna_board_activity(card_id);
      CREATE TABLE IF NOT EXISTS luna_board_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, card_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, data BLOB NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS luna_board_attachments_card ON luna_board_attachments(card_id);`);
    const cols = db.prepare("PRAGMA table_info(luna_board_cards)").all() as { name: string }[];
    if (!cols.some(c => c.name === "blocked_reason")) db.exec("ALTER TABLE luna_board_cards ADD COLUMN blocked_reason TEXT");
    if (!cols.some(c => c.name === "auto")) db.exec("ALTER TABLE luna_board_cards ADD COLUMN auto TEXT");
    const attachmentCols = db.prepare("PRAGMA table_info(luna_board_attachments)").all() as { name: string }[];
    if (!attachmentCols.some(c => c.name === "upload_id")) db.exec("ALTER TABLE luna_board_attachments ADD COLUMN upload_id TEXT");
  }
  list(project: number, o: { status?: CardStatus; archived?: boolean } = {}): Card[] {
    const rows = this.db.prepare("SELECT * FROM luna_board_cards WHERE project_id=? AND archived=?").all(project, o.archived ? 1 : 0) as Row[];
    const files = this.files(project);
    return rows.map(toCard).map(c => ({ ...c, attachments: files.get(c.id) ?? [] })).filter(c => !o.status || c.status === o.status)
      .sort((a, b) => RANK[b.priority]! - RANK[a.priority]! || a.id - b.id);
  }
  get(project: number, id: number): Card | undefined {
    const r = this.db.prepare("SELECT * FROM luna_board_cards WHERE project_id=? AND id=?").get(project, id) as Row | undefined;
    return r ? { ...toCard(r), attachments: this.attachments(r.id) } : undefined;
  }
  private files(project: number): Map<number, Attachment[]> {
    const rows = this.db.prepare("SELECT a.id,a.card_id,a.name,a.type,a.size,a.created FROM luna_board_attachments a JOIN luna_board_cards c ON c.id=a.card_id WHERE c.project_id=? ORDER BY a.id").all(project) as AttachmentRow[];
    const out = new Map<number, Attachment[]>();
    for (const r of rows) out.set(r.card_id, [...(out.get(r.card_id) ?? []), toAttachment(r)]);
    return out;
  }
  private attachments(card: number): Attachment[] {
    return (this.db.prepare("SELECT id,card_id,name,type,size,created FROM luna_board_attachments WHERE card_id=? ORDER BY id").all(card) as AttachmentRow[]).map(toAttachment);
  }
  /** Store one file on a card. */
  attach(project: number, id: number, file: { name: unknown; type: unknown; data: Uint8Array }, by = "user"): Attachment {
    this.need(project, id);
    const uploads = this.uploads;
    if (!uploads) throw new BoardError(400, "upload store unavailable");
    const requestedName = typeof file.name === "string" ? file.name.trim() : "";
    if (!requestedName) bad("file name required");
    if (!file.data.byteLength) bad("file is empty");
    if (file.data.byteLength > MAX_ATTACHMENT_BYTES) bad(`file too large (${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB max)`);
    if (this.attachments(id).length >= MAX_ATTACHMENTS) bad(`at most ${MAX_ATTACHMENTS} attachments per card`);
    const uploaded = uploads.put({ name: requestedName, mimeType: typeof file.type === "string" ? file.type : "application/octet-stream", data: file.data });
    const { name, mimeType: type } = uploaded;
    const now = Date.now();
    const r = this.db.prepare("INSERT INTO luna_board_attachments(card_id,name,type,size,created,data,upload_id) VALUES (?,?,?,?,?,?,?)")
      .run(id, name, type, uploaded.size, now, new Uint8Array(0), uploaded.id);
    this.db.prepare("UPDATE luna_board_cards SET updated=? WHERE id=?").run(now, id);
    this.log(id, by, `attached ${name}`);
    return { id: Number(r.lastInsertRowid), card: id, name, type, size: uploaded.size, created: now };
  }
  file(project: number, id: number, attachment: number): { name: string; type: string; data: Uint8Array } | undefined {
    this.need(project, id);
    const row = this.db.prepare("SELECT name,type,data,upload_id FROM luna_board_attachments WHERE id=? AND card_id=?")
      .get(attachment, id) as { name: string; type: string; data: Uint8Array; upload_id: string | null } | undefined;
    if (!row) return undefined;
    if (row.upload_id) {
      if (!this.uploads) throw new BoardError(400, "upload store unavailable");
      const data = this.uploads.read(row.upload_id);
      return { name: row.name, type: row.type, data: new Uint8Array(data) };
    }
    return { name: row.name, type: row.type, data: row.data };
  }
  detach(project: number, id: number, attachment: number, by = "user") {
    this.need(project, id);
    const a = this.attachments(id).find(x => x.id === attachment);
    if (!a) throw new BoardError(404, `attachment #${attachment} not found`);
    this.db.prepare("DELETE FROM luna_board_attachments WHERE id=?").run(attachment);
    this.db.prepare("UPDATE luna_board_cards SET updated=? WHERE id=?").run(Date.now(), id);
    this.log(id, by, `removed attachment ${a.name}`);
  }
  private need(project: number, id: number): Card {
    const c = this.get(project, id); if (!c) throw new BoardError(404, `card #${id} not found`);
    return c;
  }
  private fields(i: CardInput, cur?: Card) {
    const out: { subject: string; description: string; priority: CardPriority; status: CardStatus; owner: string | null; blocked: string | null; labels: string[]; archived: boolean; auto: CardAuto | null } = {
      subject: cur?.subject ?? "", description: cur?.description ?? "", priority: cur?.priority ?? "medium", status: cur?.status ?? "backlog",
      owner: cur?.owner ?? null, blocked: cur?.blocked ?? null, labels: cur?.labels ?? [], archived: cur?.archived ?? false, auto: cur?.auto ?? null,
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
    if (i.auto !== undefined) {
      out.auto = parseAuto(i.auto);
      // Turning auto on hands the card to the agent, unless the same change names an owner.
      if (out.auto && !cur?.auto && i.owner === undefined) out.owner = AUTO_OWNER;
    }
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
    const r = this.db.prepare(`INSERT INTO luna_board_cards(project_id,subject,description,priority,status,blocked_by,owner,labels,archived,created,updated,auto,blocked_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(project, f.subject, f.description, f.priority, f.status, JSON.stringify(blocked), f.owner, JSON.stringify(f.labels), Number(f.archived), now, now, f.auto && JSON.stringify(f.auto), f.blocked);
    const made = this.need(project, Number(r.lastInsertRowid));
    this.log(made.id, "user", `created in ${made.status}`);
    this.changed(project);
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
    this.db.prepare(`UPDATE luna_board_cards SET subject=?,description=?,priority=?,status=?,blocked_by=?,owner=?,blocked_reason=?,labels=?,archived=?,auto=?,updated=? WHERE id=? AND project_id=?`)
      .run(f.subject, f.description, f.priority, f.status, JSON.stringify(blocked), f.owner, f.blocked, JSON.stringify(f.labels), Number(f.archived), f.auto && JSON.stringify(f.auto), Date.now(), id, project);
    const by = actor ?? "user";
    if (cur.status !== f.status) this.log(id, by, `moved ${cur.status} -> ${f.status}`);
    if (cur.archived !== f.archived) this.log(id, by, f.archived ? "archived" : "restored");
    if (cur.owner !== f.owner) this.log(id, by, `owner ${cur.owner ?? "none"} -> ${f.owner ?? "none"}`);
    if (cur.blocked !== f.blocked) this.log(id, by, f.blocked ? `blocked: ${f.blocked}` : "unblocked");
    if (JSON.stringify(cur.auto) !== JSON.stringify(f.auto)) this.log(id, by, f.auto ? `auto on (${autoLabel(f.auto)})` : "auto off");
    this.changed(project);
    return this.need(project, id);
  }
  /**
   * User-only: move a card to another project. The card id, attachments, and activity stay with it.
   * Dependencies that point at cards outside the target project are dropped, the old project stops waiting on it,
   * and a session owner is released because that session reads another board.
   */
  move(project: number, id: number, target: number): Card {
    const cur = this.need(project, id);
    if (target === project) return cur;
    const keep = new Set([...this.list(target), ...this.list(target, { archived: true })].map(c => c.id));
    const blocked = cur.blockedBy.filter(d => keep.has(d));
    const released = ownerSession(cur.owner) !== undefined;
    const now = Date.now();
    this.db.prepare("UPDATE luna_board_cards SET project_id=?,blocked_by=?,owner=?,updated=? WHERE id=? AND project_id=?")
      .run(target, JSON.stringify(blocked), released ? null : cur.owner, now, id, project);
    for (const c of [...this.list(project), ...this.list(project, { archived: true })]) {
      if (!c.blockedBy.includes(id)) continue;
      this.db.prepare("UPDATE luna_board_cards SET blocked_by=?,updated=? WHERE id=?").run(JSON.stringify(c.blockedBy.filter(d => d !== id)), now, c.id);
    }
    const notes = [released ? `owner ${cur.owner} released` : "", blocked.length < cur.blockedBy.length ? `${cur.blockedBy.length - blocked.length} dependency reference(s) cleared` : ""].filter(Boolean);
    this.log(id, "user", `moved from project #${project} to #${target}${notes.length ? `; ${notes.join("; ")}` : ""}`);
    this.changed(project); this.changed(target);
    return this.need(target, id);
  }
  private readonly listeners = new Set<(project: number) => void>();
  /** Called after a card is created, changed, or moved. Listeners run after the current task, outside the write. */
  onChange(fn: (project: number) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private changed(project: number) { for (const fn of this.listeners) queueMicrotask(() => { try { fn(project); } catch { /* listener errors stay local */ } }); }
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
    this.db.prepare("DELETE FROM luna_board_attachments WHERE card_id=?").run(id);
  }
  deleteProject(project: number) {
    this.db.prepare("DELETE FROM luna_board_attachments WHERE card_id IN (SELECT id FROM luna_board_cards WHERE project_id=?)").run(project);
    this.db.prepare("DELETE FROM luna_board_activity WHERE card_id IN (SELECT id FROM luna_board_cards WHERE project_id=?)").run(project);
    this.db.prepare("DELETE FROM luna_board_cards WHERE project_id=?").run(project);
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
  action: StringEnum(["list", "get", "create", "update", "archive"]),
  id: Type.Optional(Type.Number({ description: "Card id (get, update, archive)" })),
  subject: Type.Optional(Type.String({ description: "Card name (required for create)" })),
  description: Type.Optional(Type.String({ description: "Long-form description" })),
  priority: Type.Optional(StringEnum(PRIORITIES, { description: "low, medium (default), high, or urgent" })),
  status: Type.Optional(StringEnum(STATUSES, { description: "Column: backlog (default), todo, in_progress, review, done. With list it filters." })),
  owner: Type.Optional(Type.String({ description: "Who works on the card. Moving a card to in_progress sets it to this session when empty." })),
  blocked: Type.Optional(Type.String({ description: "update: you cannot continue without the user. Short reason, e.g. 'needs your decision on X'. The board shows it; the user's answer arrives as a message. Empty string clears it." })),
  labels: Type.Optional(Type.Array(Type.String(), { description: "Replace the card's labels" })),
  blockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Card ids this card waits on (create)" })),
  addBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Add dependencies (update)" })),
  removeBlockedBy: Type.Optional(Type.Array(Type.Number(), { description: "Remove dependencies (update)" })),
  includeArchived: Type.Optional(Type.Boolean({ description: "list: show archived cards instead of active ones" })),
});

/** Validate the `auto` input: null (off) or { model?: "provider/modelId" | null, thinking?: level | null }. */
export function parseAuto(v: unknown): CardAuto | null {
  if (v === null || v === false) return null;
  if (v === true) return { model: null, thinking: null };
  if (typeof v !== "object" || Array.isArray(v)) return bad("auto must be null or { model, thinking }");
  const { model = null, thinking = null, ...rest } = v as Record<string, unknown>;
  if (Object.keys(rest).length) bad(`auto has unknown field ${Object.keys(rest)[0]}`);
  if (model !== null && (typeof model !== "string" || !/^[^/\s]+\/\S+$/.test(model) || model.length > 200)) bad("auto.model must be provider/modelId, or null for the default");
  if (thinking !== null && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) bad(`auto.thinking must be one of ${THINKING_LEVELS.join(", ")}, or null for the default`);
  return { model: model as string | null, thinking: thinking as ThinkingLevel | null };
}
export const autoLabel = (a: CardAuto) => `${a.model ?? "default model"}${a.thinking ? `, ${a.thinking}` : ""}`;

const line = (c: Card) => `#${c.id} [${c.status}|${c.priority}${c.archived ? "|archived" : ""}${c.auto ? "|auto" : ""}] ${c.subject}${c.owner ? ` (${c.owner})` : ""}${c.blocked ? ` BLOCKED: ${c.blocked}` : ""}${c.blockedBy.length ? ` waits on ${c.blockedBy.map(d => "#" + d).join(",")}` : ""}${c.labels.length ? ` {${c.labels.join(",")}}` : ""}`;
const detail = (c: Card) => [line(c), ...(c.attachments.length ? [`  attachments: ${c.attachments.map(a => `${a.name} (${a.size} bytes)`).join(", ")}`] : []), ...(c.description ? [`  description: ${c.description}`] : []), `  updated: ${new Date(c.updated).toISOString()}`].join("\n");

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

/** Extension: the `board` tool and prompt details only for explicit card mentions. Unlinked chat sessions use General. */
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
              case "create": { const { auto: _auto, ...input } = a as typeof a & { auto?: unknown }; const c = board.create(pid, input); conv.touch(); return `Created #${c.id}: ${c.subject} (${c.status}, ${c.priority})`; }
              case "update": {
                if (a.id === undefined) bad("id required for update");
                // Only the user arms automatic runs.
                const { id, action, includeArchived, auto: _auto, ...changes } = a as typeof a & { auto?: unknown };
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
      const runtime = input.read as { context?: (id: typeof input.conversationId, ctx: typeof context) => Promise<{ messages: readonly { role?: string; content?: unknown }[] }> };
      const view = typeof runtime.context === "function" ? await runtime.context(input.conversationId, context).catch(() => undefined) : undefined;
      const mentioned = view ? conv!.board.mentioned(p.id, extractMentionedCardIds(view.messages)) : "";
      return mentioned || undefined;
    })],
  });
}
