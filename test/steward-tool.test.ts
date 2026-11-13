// Contract: the wife tool validates model cards at the boundary, memory cards write and undo, and the luna-wife job follows config.
import { test, expect } from "bun:test";
import { buildCard } from "../src/wife/tool.js";
import { WifeStore } from "../src/wife/store.js";
import { WifeService } from "../src/wife/service.js";
import { CronStore } from "../src/scheduler.js";
import { syncWifeJob, WIFE_JOB_NAME } from "../src/runtime.js";

const exists = (id: number) => id === 1 || id === 2;
const memCard = { action: "suggest" as const, kind: "memory" as const, title: "Prefers Bun", body: "Said it twice.", evidence: [{ sessionId: 1, note: "said so" }], payload: { key: "user.runtime", content: "Bun only" } };

test("buildCard rejects bad cards and builds a stable fingerprint", () => {
  expect(String(buildCard({ ...memCard, evidence: [{ sessionId: 99, note: "x" }] }, exists))).toMatch(/does not exist/);
  expect(String(buildCard({ ...memCard, evidence: [] }, exists))).toMatch(/evidence/);
  expect(String(buildCard({ ...memCard, payload: {} }, exists))).toMatch(/content/);
  expect(String(buildCard({ ...memCard, kind: "skill", payload: { name: "x" } }, exists))).toMatch(/outline/);
  const a = buildCard(memCard, exists), b = buildCard({ ...memCard, title: "Other title" }, exists);
  expect((a as { fingerprint: string }).fingerprint).toBe("memory:user-runtime");
  expect((a as { fingerprint: string }).fingerprint).toBe((b as { fingerprint: string }).fingerprint);
  expect((a as { source: string }).source).toBe("model");
});

test("agreeing to a memory card saves it, and undo restores the earlier value", async () => {
  const facts = new Map<string, string>([["user.runtime", "Node"]]);
  const store = new WifeStore(":memory:");
  const wife = new WifeService({ store, conversations: {} as never, analytics: () => ({}) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }),
    remember: ({ key, content }) => { const before = facts.get(key!) ?? null; facts.set(key!, content); return { key: key!, before }; },
    restoreMemory: (key, content) => { if (content === null) facts.delete(key); else facts.set(key, content); } });
  const card = store.file(buildCard(memCard, exists) as never)!;
  const done = await wife.agree(card.id, {});
  expect(done.status).toBe("done");
  expect(facts.get("user.runtime")).toBe("Bun only");
  await wife.undo(card.id);
  expect(facts.get("user.runtime")).toBe("Node");
  store.close();
});

test("the luna-wife job is created, rescheduled and switched off with config", () => {
  const cron = new CronStore(":memory:");
  const job = () => cron.listJobs().find(j => j.name === WIFE_JOB_NAME);
  syncWifeJob(cron, { enabled: true, modelSchedule: "0 4 * * *" }, true);
  expect(job()?.expr).toBe("0 4 * * *");
  syncWifeJob(cron, { enabled: true, modelSchedule: "0 5 * * *" }, true);
  expect(cron.listJobs().filter(j => j.name === WIFE_JOB_NAME).length).toBe(1);
  expect(job()?.expr).toBe("0 5 * * *");
  syncWifeJob(cron, { enabled: true, modelSchedule: "" }, true);
  expect(job()?.enabled).toBe(false);
  syncWifeJob(cron, { enabled: true, modelSchedule: "0 5 * * *" }, true);
  expect(job()?.enabled).toBe(true);
  cron.close?.();
});

test("the scheduler records a skipped slot with reason unchanged and runs nothing", async () => {
  const { CronStore } = await import("../src/scheduler.js");
  const s = new CronStore(":memory:");
  const job = s.addJob("j", "* * * * *", "p", undefined, 0, "changes");
  const j = s.listJobs().find(x => x.id === (job as { id: number }).id)!;
  expect(s.claim(j, j.nextRun! + 1, "nothing changed")).toBe(undefined);
  const r = s.queryRuns({ jobId: j.id, history: true })[0]!;
  expect([r.status, r.reason]).toEqual(["skipped", "unchanged"]);
});
