import type { SessionState } from "../session-status.js";
import type { RecoverySummary } from "../scheduled-messages.js";

export type SessionItem = SessionState & {
  id: unknown;
  parent: unknown;
  project: number | null;
  title: string;
  archived: boolean;
  pinned: boolean;
  running: boolean;
  resumeAt: number | null;
  recovery: RecoverySummary | null;
  lastActivity: number | null;
  createdAt: number | null;
  worker: number | null;
};

export type GroupSummary = {
  count: number;
  lastActivity: number;
  activity: number;
  statuses: Record<string, number>;
  machines: Record<string, number>;
};

export type DecodedCursor = {
  pinned: number;
  activity: number;
  id: number;
};

export function encodeCursor(item: SessionItem): string {
  const pinned = item.pinned ? 1 : 0;
  const activity = (item.lastActivity ?? item.createdAt ?? 0);
  const id = Number(item.id);
  const payload = JSON.stringify([pinned, activity, id]);
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursorStr: string): DecodedCursor | null {
  try {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursorStr)) return null;
    const raw = Buffer.from(cursorStr, "base64url").toString("utf8");
    if (Buffer.from(raw, "utf8").toString("base64url") !== cursorStr) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [pinned, activity, id] = parsed;
    if (pinned !== 0 && pinned !== 1) return null;
    if (!Number.isSafeInteger(activity) || activity < 0) return null;
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return { pinned, activity, id };
  } catch {
    return null;
  }
}

export function compareSessions(a: SessionItem, b: SessionItem): number {
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (b.lastActivity ?? b.createdAt ?? 0) - (a.lastActivity ?? a.createdAt ?? 0) ||
    Number(b.id) - Number(a.id)
  );
}

export function isAfterCursor(item: SessionItem, cursor: DecodedCursor): boolean {
  const itemPinned = item.pinned ? 1 : 0;
  const itemActivity = (item.lastActivity ?? item.createdAt ?? 0);
  const itemId = Number(item.id);

  // Sorting descending: [pinned desc, activity desc, id desc]
  // An item comes AFTER the cursor in sort order if:
  // 1. item.pinned < cursor.pinned
  // 2. item.pinned === cursor.pinned && itemActivity < cursor.activity
  // 3. item.pinned === cursor.pinned && itemActivity === cursor.activity && itemId < cursor.id
  if (itemPinned < cursor.pinned) return true;
  if (itemPinned > cursor.pinned) return false;

  if (itemActivity < cursor.activity) return true;
  if (itemActivity > cursor.activity) return false;

  return itemId < cursor.id;
}
