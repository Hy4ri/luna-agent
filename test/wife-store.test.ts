// Contract: a dismissed card never comes back, an open card is refreshed not duplicated, snooze expires, and a detector can withdraw only open cards.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { WifeStore, type NewSuggestion } from "../src/wife/store.js";
import { staleSessions } from "../src/wife/detectors.js";

const card = (fp: string, body = "why"): NewSuggestion => ({ kind: "archive_session", fingerprint: fp, title: "t", body, evidence: [], payload: { sessionId: 1 }, source: "detector" });

test("filing dedupes by fingerprint and respects decisions", () => {
  let now = 1000;
  const s = new WifeStore(":memory:", () => now);
  const a = s.file(card("a"))!;
  s.file(card("a", "newer"));
  assert.equal(s.list().length, 1);
  assert.equal(s.get(a.id)!.body, "newer");
  s.setStatus(a.id, "dismissed");
  assert.equal(s.file(card("a", "again")), undefined);
  assert.equal(s.get(a.id)!.status, "dismissed");
  assert.equal(s.get(a.id)!.body, "newer");
  s.close();
});

test("a snoozed card reopens after its time", () => {
  let now = 1000;
  const s = new WifeStore(":memory:", () => now);
  const a = s.file(card("a"))!;
  s.setStatus(a.id, "snoozed", { snoozeUntil: 5000 });
  assert.equal(s.expireSnoozed(4999), 0);
  assert.equal(s.expireSnoozed(5000), 1);
  assert.equal(s.get(a.id)!.status, "open");
  s.close();
});

test("withdraw removes only open cards that no longer apply", () => {
  const s = new WifeStore(":memory:");
  const a = s.file(card("a"))!, b = s.file(card("b"))!, c = s.file(card("c"))!;
  s.setStatus(b.id, "dismissed");
  assert.equal(s.withdrawOpen("archive_session", new Set(["c"])), 1);
  assert.equal(s.get(a.id), undefined);
  assert.equal(s.get(b.id)!.status, "dismissed");
  assert.ok(s.get(c.id));
  s.close();
});

test("stale detector skips pinned, child, running and recent sessions", () => {
  const day = 86_400_000, now = 100 * day;
  const base = { title: null, parentId: null, projectId: 0, projectName: "", worker: "", cwd: null, createdAt: 0, status: "idle", statusReason: null, archived: false, pinned: false, deletedAt: null } as const;
  const mk = (id: number, over: object) => ({ ...base, id, lastActivity: now - 30 * day, ...over }) as never;
  const out = staleSessions([mk(1, {}), mk(2, { pinned: true }), mk(3, { parentId: 1 }), mk(4, { status: "running" }), mk(5, { lastActivity: now - day }),
    mk(6, { archived: true, lastActivity: now - 70 * day }), mk(7, { archived: true })], { staleDays: 14, deleteArchivedAfterDays: 60 }, now);
  assert.deepEqual(out.map(o => o.fingerprint).sort(), ["archive_session:1", "delete_session:6"]);
});
