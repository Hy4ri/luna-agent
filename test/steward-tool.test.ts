// Contract: the steward tool validates model cards at the boundary, memory cards write and undo, and the luna-steward job follows config.
import { test, expect } from "bun:test";
import { buildCard } from "../src/steward/tool.js";
import { StewardStore } from "../src/steward/store.js";
import { StewardService } from "../src/steward/service.js";
import { CronStore } from "../src/scheduler.js";
import { syncStewardJob, STEWARD_JOB_NAME } from "../src/runtime.js";

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
  const store = new StewardStore(":memory:");
  const steward = new StewardService({ store, conversations: {} as never, analytics: () => ({}) as never, config: () => ({ enabled: true, detectEveryMinutes: 30, staleDays: 14, deleteArchivedAfterDays: 60 }),
    remember: ({ key, content }) => { const before = facts.get(key!) ?? null; facts.set(key!, content); return { key: key!, before }; },
    restoreMemory: (key, content) => { if (content === null) facts.delete(key); else facts.set(key, content); } });
  const card = store.file(buildCard(memCard, exists) as never)!;
  const done = await steward.agree(card.id, {});
  expect(done.status).toBe("done");
  expect(facts.get("user.runtime")).toBe("Bun only");
  await steward.undo(card.id);
  expect(facts.get("user.runtime")).toBe("Node");
  store.close();
});

test("the luna-steward job is created, rescheduled and switched off with config", () => {
  const cron = new CronStore(":memory:");
  const job = () => cron.listJobs().find(j => j.name === STEWARD_JOB_NAME);
  syncStewardJob(cron, { enabled: true, modelSchedule: "0 4 * * *" }, true);
  expect(job()?.expr).toBe("0 4 * * *");
  syncStewardJob(cron, { enabled: true, modelSchedule: "0 5 * * *" }, true);
  expect(cron.listJobs().filter(j => j.name === STEWARD_JOB_NAME).length).toBe(1);
  expect(job()?.expr).toBe("0 5 * * *");
  syncStewardJob(cron, { enabled: true, modelSchedule: "" }, true);
  expect(job()?.enabled).toBe(false);
  syncStewardJob(cron, { enabled: true, modelSchedule: "0 5 * * *" }, true);
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

test("backward compat: syncStewardJob adopts luna-wife, extension registers wife alias, and /v1/wife routes work", async () => {
  const { CronStore } = await import("../src/scheduler.js");
  const { syncStewardJob, STEWARD_JOB_NAME } = await import("../src/runtime.js");
  const { createStewardExtension } = await import("../src/steward/tool.js");
  const { registerSteward } = await import("../src/routes/steward.js");
  const { Hono } = await import("hono");

  const cron = new CronStore(":memory:");
  cron.addJob("luna-wife", "0 4 * * *", "old", undefined, 0, "changes");
  syncStewardJob(cron, { enabled: true, modelSchedule: "0 5 * * *" }, true);
  const jobs = cron.listJobs();
  expect(jobs.length).toBe(1);
  expect(jobs[0]!.name).toBe(STEWARD_JOB_NAME);
  cron.close?.();

  const ext = createStewardExtension({ steward: () => undefined, sessionExists: () => false });
  expect(ext.tools?.map(t => t.name)).toEqual(["steward", "wife"]);

  const app = new Hono();
  registerSteward(app, { opts: { steward: undefined } as any, err: ((c: any, s: any, m: any) => c.json({ error: m }, s)) as any } as any);
  const r1 = await app.request("/v1/steward/count");
  const r2 = await app.request("/v1/wife/count");
  expect(r1.status).toBe(404);
  expect(r2.status).toBe(404);
});
