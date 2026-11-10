// Contract: attention pages retain global error-first ordering, and read-all covers the full inbox.
// A legacy ID-only cursor skips older errors; marking only loaded rows leaves unseen inbox reports unread.
// No existing store test covers cron report ordering or superseded-report read state.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CronStore } from "../src/scheduler.js";

// The inbox is the newest report of each job, while it is unread. The lookup became a per-job seek, so it has
// to keep agreeing with a plain reference over the whole table: newest report per job, empty output is no
// report, a running run is no report, a read report leaves the inbox and stays in the history.
test("inbox matches a plain reference over the whole run table", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-cron-inbox-semantics-"));
  const store = new CronStore(join(dir, "cron.db"));
  try {
    const now = 1_000_000;
    for (let i = 0; i < 12; i++) {
      const job = store.addJob(`sem-${i}`, "0 * * * *", "Report", undefined, now);
      // Every job gets a report, then a mix of noise: empty output, errors, and a running run.
      const first = store.claimManual(job, now + i * 100);
      store.finish(first.id, "ok", `first ${i}`, null, now + i * 100 + 1);
      if (i % 3 === 0) {
        const empty = store.claimManual(job, now + i * 100 + 10);
        store.finish(empty.id, "ok", "   ", null, now + i * 100 + 11);
      }
      if (i % 4 === 1) {
        const failing = store.claimManual(job, now + i * 100 + 20);
        store.finish(failing.id, "error", null, `boom ${i}`, now + i * 100 + 21);
      }
      if (i % 5 === 2) {
        const second = store.claimManual(job, now + i * 100 + 30);
        store.finish(second.id, "ok", `second ${i}`, null, now + i * 100 + 31);
      }
      if (i % 6 === 3) store.claimManual(job, now + i * 100 + 40); // still running
    }

    // Reference: the newest report of each job, straight from the table.
    const reference = new Map<number, number>();
    for (const row of store.db.prepare(
      "SELECT job_id, MAX(id) AS id FROM runs WHERE report=1 AND status != 'running' AND (TRIM(COALESCE(output,''))!='' OR TRIM(COALESCE(error,''))!='') GROUP BY job_id"
    ).all() as { job_id: number; id: number }[]) reference.set(row.job_id, row.id);

    const inbox = store.reports({ limit: 100 });
    const expected = [...reference.values()].filter(id => store.getRun(id)!.readAt === null).sort((a, b) => b - a);
    assert.deepEqual(inbox.map(run => run.id), expected);
    assert.equal(store.unreadCount(), expected.length);

    // Reading the newest report of a job empties its inbox entry and leaves the report in the history.
    const target = inbox[0]!;
    store.markRead(target.id, true);
    assert.ok(!store.reports({ limit: 100 }).some(run => run.id === target.id));
    assert.equal(store.unreadCount(), expected.length - 1);
    assert.ok(store.reports({ history: true, limit: 100 }).some(run => run.id === target.id));

    // Marking it unread again puts it back, and it is still the newest report of its job.
    store.markRead(target.id, false);
    assert.ok(store.reports({ limit: 100 }).some(run => run.id === target.id));
    assert.equal(store.unreadCount(), expected.length);

    // A newer report replaces the older unread one: the older report leaves the inbox and stays unread in the
    // history.
    const superseded = expected[1]!;
    const job = store.getJob(store.getRun(superseded)!.jobId)!;
    const newer = store.claimManual(job, now + 900_000);
    store.finish(newer.id, "ok", "newest", null, now + 900_001);
    const after = store.reports({ limit: 100 });
    assert.ok(after.some(run => run.id === newer.id));
    assert.ok(!after.some(run => run.id === superseded));
    assert.equal(store.getRun(superseded)!.readAt, null, "a superseded report keeps its unread state");
    assert.ok(store.reports({ history: true, limit: 100 }).some(run => run.id === superseded));

    // Read all covers the whole inbox, and only the inbox.
    const inboxBefore = store.unreadCount();
    const marked = store.markAllReportsRead(now + 950_000);
    assert.equal(marked, inboxBefore);
    assert.equal(store.unreadCount(), 0);
    assert.deepEqual(store.reports(), []);
    assert.equal(store.getRun(superseded)!.readAt, null, "read-all must not rewrite the superseded history");
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("attention cursor spans errors and successes without losing reports; read-all leaves superseded history untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-cron-reports-"));
  let store = new CronStore(join(dir, "cron.db"));
  try {
    const errors: number[] = [], successes: number[] = [];
    let superseded = 0;
    for (let i = 0; i < 45; i++) {
      const job = store.addJob(`report-${i}`, "0 * * * *", "Report", undefined, 1_000);
      if (i === 0) {
        const old = store.claimManual(job, 2_000);
        store.finish(old.id, "error", null, "Superseded error", 2_001);
        superseded = old.id;
      }
      const run = store.claimManual(job, 3_000);
      const error = i < 23;
      store.finish(run.id, error ? "error" : "ok", error ? null : `Output ${i}`, error ? `Error ${i}` : null, 3_001);
      (error ? errors : successes).push(run.id);
    }
    const expected = [...errors.reverse(), ...successes.reverse()];
    const pages: number[][] = [];
    let cursor: { rank: number; id: number } | undefined;
    for (let i = 0; i < 4; i++) {
      const page = store.reports({ order: "attention", limit: 20, cursor });
      pages.push(page.map(run => run.id));
      if (!page.length) break;
      const last = page.at(-1)!;
      cursor = { rank: last.status === "error" ? 0 : 1, id: last.id };
    }
    assert.deepEqual(pages.map(page => page.length), [20, 20, 5, 0]);
    assert.deepEqual(pages.flat(), expected);
    assert.equal(store.unreadCount(), 45);
    const legacy = store.reports({ limit: 20 });
    assert.deepEqual(legacy.map(run => run.id), [...expected].sort((a, b) => b - a).slice(0, 20));
    assert.ok(store.reports({ before: legacy.at(-1)!.id }).every(run => run.id < legacy.at(-1)!.id));
    assert.equal(store.markAllReportsRead(5_000), 45);
    assert.equal(store.markAllReportsRead(6_000), 0);
    assert.equal(store.unreadCount(), 0);
    assert.deepEqual(store.reports(), []);
    assert.equal(store.getRun(superseded)!.readAt, null, "read-all must not rewrite superseded history");
    assert.ok(expected.every(id => store.getRun(id)!.readAt === 5_000));
    store.close(); store = new CronStore(join(dir, "cron.db"));
    assert.equal(store.unreadCount(), 0);
    assert.equal(store.reports({ history: true, limit: 100 }).length, 46);
  } finally {
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

// The HTTP route must validate cursor combinations and mark unseen pages read, not parse read-all as a run ID.
test("cron report HTTP pagination validates cursors and read-all covers unloaded pages", async () => {
  const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
  const { openLuna, context } = await import("../src/luna.js");
  const { ConversationStore } = await import("../src/conversations.js");
  const { createApp } = await import("../src/server.js");
  const dir = mkdtempSync(join(tmpdir(), "luna-cron-reports-http-"));
  const store = new CronStore(join(dir, "cron.db"));
  const models = createModels(), faux = fauxProvider(); models.setProvider(faux.provider);
  const model = faux.getModel();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  try {
    const app = createApp({ harness, conversations: new ConversationStore(harness), models, store,
      agent: { model: { provider: model.provider, modelId: model.id } } });
    for (let i = 0; i < 23; i++) {
      const job = store.addJob(`http-report-${i}`, "0 * * * *", "Report", undefined, 1_000);
      const run = store.claimManual(job, 2_000);
      store.finish(run.id, i < 21 ? "error" : "ok", i < 21 ? null : "Output", i < 21 ? "Error" : null, 2_001);
    }
    const first = await app.request("/v1/cron/reports?order=attention&limit=20");
    assert.equal(first.status, 200);
    const page = await first.json() as { reports: { id: number; status: string }[]; unreadCount: number; nextCursor: string };
    assert.equal(page.reports.length, 20); assert.equal(page.unreadCount, 23);
    assert.ok(page.reports.every(run => run.status === "error"));
    const second = await app.request(`/v1/cron/reports?order=attention&limit=20&cursor=${encodeURIComponent(page.nextCursor)}`);
    const rest = await second.json() as typeof page;
    assert.equal(rest.reports.length, 3); assert.equal(rest.nextCursor, null);
    assert.equal(new Set([...page.reports, ...rest.reports].map(run => run.id)).size, 23);
    for (const query of ["order=unknown", "order=attention&history=1", "cursor=0:1", "order=attention&before=1",
      "order=attention&cursor=2:1", "order=attention&cursor=0:0", "order=attention&cursor=0:9007199254740992",
      "order=attention&cursor=0:1:2", "order=attention&limit=101"]) {
      assert.equal((await app.request(`/v1/cron/reports?${query}`)).status, 400, query);
    }
    const read = await app.request("/v1/cron/reports/read-all", { method: "POST" });
    assert.equal(read.status, 200); assert.equal(store.unreadCount(), 0);
    assert.equal(store.reports({ history: true, limit: 100 }).length, 23);
  } finally { store.close(); await harness.close(context); rmSync(dir, { recursive: true, force: true }); }
});
