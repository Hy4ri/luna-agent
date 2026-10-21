// Verifies session learning end to end on a real runtime with a faux model:
// detector units -> idle scan of real conversations -> deterministic tool lessons -> daily cron pass drives the deferred
// learn tools -> the agent applies routine fixes, holds critical ones and dismisses noise -> evidence/cause/growth gates
// -> HTTP queue for critical proposals (approve/reject/rollback) -> recurrence -> code-guard flag -> confirmation.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { detectSignals, LEARN_JOB, LearnStore, redact, type ScanMessage } from "./learn.js";
import { DatabaseSync } from "node:sqlite";

const ok = (m: string) => console.log("OK", m);

// ---- detector units ----
{
  const m = (entry: number, role: ScanMessage["role"], text: string, extra: Partial<ScanMessage> = {}): ScanMessage => ({ entry, role, text, ts: entry, calls: [], ...extra });
  const sig = detectSignals([
    m(1, "user", "no, wait"), // before any assistant turn: not a correction
    m(2, "assistant", "", { calls: [{ name: "skill_view", args: { name: "deploy" } }, { name: "bash", args: {} }] }),
    m(3, "toolResult", "error: ENOENT /a/b", { toolName: "bash", isError: true }),
    m(4, "toolResult", "ok", { toolName: "bash", isError: false }),
    m(5, "toolResult", "permission denied", { toolName: "write", isError: true }),
    m(6, "user", "No, I said staging. token=abc123secretvalue"),
    m(7, "assistant", "ok"),
    m(8, "user", "غلط، استخدم الفرع الثاني"),
    m(9, "user", "From now on always run the tests first"),
    m(10, "user", "[process finished] exit 0"),
    m(11, "user", "thanks, looks good"),
  ]);
  assert.deepEqual(sig.map((s) => [s.entry, s.kind]), [[3, "recovery"], [5, "tool_error"], [6, "correction"], [8, "correction"], [9, "rule"]]);
  assert.match(sig[0]!.key!, /^recovery:bash:/);
  assert.equal(sig[2]!.key, "after:bash");
  assert.deepEqual(sig[2]!.skills, ["deploy"]);
  assert.ok(!sig[2]!.summary.includes("abc123secretvalue"), sig[2]!.summary);
  ok("detector: corrections (EN+AR), rules, recovery vs unrecovered errors, skills loaded, system notices skipped");
  for (const s of ["sk-ant-api03-abcdefghijklmnop", "ghp_abcdefghijklmnopqrstuvwxyz0123", "Authorization: Bearer abcdefghijklmnopqrstu", "password = hunter2hunter2", "AKIAABCDEFGHIJKLMNOP"])
    assert.ok(!redact(`x ${s} y`).includes(s.split(/[ =:]+/).at(-1)!), `not redacted: ${s} -> ${redact(s)}`);
  ok("redaction strips tokens, keys and passwords");
}

const d = mkdtempSync(join(process.cwd(), ".vlearn-"));
try {
  // ---- migration: a learn.db from before the critical column opens and keeps its pending proposal for the user ----
  {
    const old = new DatabaseSync(join(d, "old.db"));
    old.exec(`CREATE TABLE lessons (id INTEGER PRIMARY KEY, key TEXT UNIQUE, claim TEXT NOT NULL, cause TEXT, scope TEXT NOT NULL DEFAULT 'skill', skill TEXT,
      status TEXT NOT NULL DEFAULT 'candidate', proposal TEXT, tests TEXT, fact_key TEXT, note TEXT, needs_guard INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, version INTEGER, applied_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL);
      INSERT INTO lessons(claim, status, proposal, created, updated) VALUES ('old', 'proposed', 'x', 1, 1);`);
    old.close();
    const migrated = new LearnStore(join(d, "old.db"));
    assert.equal(migrated.lesson(1)!.critical, "proposed before automatic review", "an old pending proposal stays with the user");
    migrated.close();
    ok("migration adds the critical column; old pending proposals stay held for the user");
  }

  const data = join(d, "data");
  const skillsDir = join(data, "skills");
  mkdirSync(join(skillsDir, "deploy"), { recursive: true });
  const v0 = "---\nname: deploy\ndescription: Use when deploying services to a host.\n---\nBuild, then deploy with the deploy script.\n";
  writeFileSync(join(skillsDir, "deploy", "SKILL.md"), v0);
  writeFileSync(join(d, "real.txt"), "hello");

  const cfg = parseConfig({ dataDir: data, cwd: d, improve: {}, learn: { idleMinutes: 0.00001 } }, d, {});
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel();
  const model = { provider: fm.provider, modelId: fm.id };
  const logs: string[] = [];
  const rt = await startRuntime(cfg, { models, model, log: (m) => logs.push(m) });
  try {
    assert.ok(rt.learn && rt.improver, "learn wired by default");
    const L = rt.learn!;
    await rt.learnScan(); // startup scan may also be running; both are safe
    const job = rt.store!.listJobs().find((j) => j.name === LEARN_JOB);
    assert.ok(job && job.enabled && job.expr === "0 4 * * *", "daily learn job synced");
    const root = await rt.harness.root(context, { agent: { model } });
    const agent = await root.agent(context);
    for (const t of ["learn_review", "lesson_record", "lesson_propose", "lesson_dismiss"]) {
      assert.ok(agent.deferred.some((x) => x.name === t), `${t} deferred`);
      assert.ok(!agent.tools.some((x) => x.name === t), `${t} must not be in every prompt`);
    }
    ok("learn extension wired; tools deferred; daily job created");

    // One real conversation: loads the skill, a tool fails then succeeds, the user corrects or states a rule.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const session = async (userTurns: string[], opts: { fail?: boolean; skill?: boolean } = {}) => {
      const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
      const steps = [
        ...(opts.skill !== false ? [fauxAssistantMessage([fauxToolCall("skill_view", { name: "deploy" })], { stopReason: "toolUse" })] : []),
        ...(opts.fail ? [
          fauxAssistantMessage([fauxToolCall("read", { path: join(d, `missing-${conv.id}.txt`) })], { stopReason: "toolUse" }),
          fauxAssistantMessage([fauxToolCall("read", { path: join(d, "real.txt") })], { stopReason: "toolUse" }),
        ] : []),
        fauxAssistantMessage([fauxText("deployed to production")]),
      ];
      faux.setResponses(steps);
      assert.equal((await (await conv.submit({ type: "input", content: "deploy the api" }, context)).wait(context)).status, "done");
      for (const t of userTurns) {
        faux.setResponses([fauxAssistantMessage([fauxText("understood")])]);
        assert.equal((await (await conv.submit({ type: "input", content: t }, context)).wait(context)).status, "done");
      }
      await sleep(5);
      return conv.id as number;
    };
    const c1 = await session(["No, I said deploy to staging first."], { fail: true });
    const c2 = await session(["From now on always deploy to staging before production."], { fail: true });
    await rt.learnScan();
    const tool = L.lessons().find((l) => l.key?.startsWith("recovery:read:"));
    assert.ok(tool, "tool recovery lesson grouped by key: " + JSON.stringify(L.lessons()));
    assert.equal(L.sessions(tool!.id), 2);
    assert.equal(tool!.status, "corroborated");
    const un = L.unassigned();
    assert.deepEqual(un.map((s) => [s.conv, s.kind]), [[c1, "correction"], [c2, "rule"]]);
    assert.deepEqual(JSON.parse(un[0]!.skills), ["deploy"]);
    const signalsBefore = (L.db.prepare("SELECT COUNT(*) n FROM signals").get() as { n: number }).n;
    await rt.learnScan();
    assert.equal((L.db.prepare("SELECT COUNT(*) n FROM signals").get() as { n: number }).n, signalsBefore, "rescan without new entries is a no-op");
    ok("idle scan of real conversations: signals with pointers, tool lesson corroborated by 2 sessions, rescan idempotent");

    // ---- daily pass: the model drives the deferred tools through the cron job ----
    const v1 = "---\nname: deploy\ndescription: Use when deploying services to a host.\n---\nDeploy to staging first, verify, then production. Build, then deploy with the deploy script.\n";
    const outputs: string[] = [];
    const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join(""));
    let step = 0;
    const respond = (c: any) => {
      const tr = c.messages.filter((x: any) => x.role === "toolResult");
      if (tr.length) outputs[tr.length - 1] = textOf(tr.at(-1));
      const [corr, rule] = L.unassigned();
      switch (step++) {
        case 0: return fauxAssistantMessage([fauxToolCall("tool_search", { query: "learn lessons review record propose" })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("learn_review", {})], { stopReason: "toolUse" });
        case 2: return fauxAssistantMessage([fauxToolCall("lesson_record", { claim: "Deploy to staging before production.", cause: "missing", skill: "deploy", signal_ids: [corr!.id, rule!.id] })], { stopReason: "toolUse" });
        case 3: return fauxAssistantMessage([fauxToolCall("lesson_propose", { lesson_id: L.lessons().find((l) => l.skill === "deploy")!.id, content: v1, must_contain: ["staging first"], critical: "changes the production deploy order" })], { stopReason: "toolUse" });
        case 4: return fauxAssistantMessage([fauxToolCall("lesson_dismiss", { lesson_id: L.lessons().find((l) => l.key?.startsWith("recovery:read:"))!.id, reason: "normal retry, not a lesson" })], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("held 1 lesson, dismissed 1")]);
      }
    };
    faux.setResponses(Array(8).fill(respond));
    await rt.scheduler!.tick(job!.nextRun! + 1000);
    await rt.scheduler!.idle();
    const run = rt.store!.runs(job!.id)[0]!;
    assert.equal(run.status, "ok", JSON.stringify(run));
    assert.match(outputs[1] ?? "", /Unassigned signals:[\s\S]*correction · session/, outputs[1] ?? "");
    assert.match(outputs[2] ?? "", /\[corroborated\] Deploy to staging/, outputs[2] ?? "");
    assert.match(outputs[3] ?? "", /\[proposed, held for the user\][\s\S]*Held for the user/, outputs[3] ?? "");
    assert.match(outputs[4] ?? "", /\[rejected\][\s\S]*dismissed by Luna: normal retry/, outputs[4] ?? "");
    assert.equal(readFileSync(join(skillsDir, "deploy", "SKILL.md"), "utf8"), v0, "a critical fix is not applied before approval");
    const lesson = L.lessons().find((l) => l.skill === "deploy")!;
    assert.equal(lesson.critical, "changes the production deploy order");
    assert.equal(L.lesson(tool!.id)!.status, "rejected", "the agent dismissed the noise lesson");
    await rt.learnScan();
    assert.ok(!L.db.prepare("SELECT 1 FROM scans WHERE conv=?").get(Number(run.conversationId)), "cron run conversations are never scanned");
    ok("daily cron pass: tool_search -> learn_review -> lesson_record -> critical lesson_propose held -> lesson_dismiss drops noise");

    // ---- gates ----
    const one = L.ingest(90001, [
      { entry: 1, role: "assistant", text: "done", ts: Date.now(), calls: [] },
      { entry: 2, role: "user", text: "No, that's the wrong file.", ts: Date.now(), calls: [] },
    ], 2);
    let single = L.record({ claim: "Check the file path.", cause: "missing", skill: "deploy", signal_ids: one });
    assert.equal(single.status, "candidate");
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1, must_contain: ["staging"] }), /needs evidence from 2\+ sessions/);
    const two = L.ingest(90002, [
      { entry: 1, role: "assistant", text: "done", ts: Date.now(), calls: [] },
      { entry: 2, role: "user", text: "No, wrong file again.", ts: Date.now(), calls: [] },
    ], 2);
    single = L.record({ lesson_id: single.id, signal_ids: two });
    assert.equal(single.status, "corroborated");
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1 }), /must_contain is required/);
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1 + "x".repeat(2000), must_contain: ["staging"] }), /budget/);
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1, must_contain: ["rollback plan"] }), /failed verification/);
    single = L.record({ lesson_id: single.id, cause: "not_loaded" });
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1, must_contain: ["staging"] }), /must change the skill description/);
    single = L.record({ lesson_id: single.id, cause: "ignored" });
    assert.equal(single.needs_guard, 1);
    await assert.rejects(L.propose(rt.improver!, { lesson_id: single.id, content: v1, must_contain: ["staging"] }), /code guard/);
    await assert.rejects(L.propose(rt.improver!, { lesson_id: lesson.id, content: v1, must_contain: ["staging first"] }), /waiting for the user/, "the agent cannot apply a held fix");
    assert.throws(() => L.dismiss(lesson.id, "noise"), /waiting for the user/, "the agent cannot dismiss a held fix");
    assert.throws(() => L.dismiss(single.id, " "), /reason is required/);
    ok("gates: evidence rule, regression phrases, growth budget, trigger fix for not_loaded, ignored -> code guard, held fixes stay with the user");

    // ---- review queue over HTTP ----
    const app = createApp({ harness: rt.harness, agent: { model }, models: rt.models, memory: rt.memory, skillDirs: rt.skillDirs,
      learn: { store: L, improver: rt.improver!, scan: rt.learnScan } });
    const post = (p: string, body: unknown = {}) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const list = await (await app.request("/v1/lessons")).json() as any;
    const view = list.lessons.find((l: any) => l.id === lesson.id);
    assert.equal(view.status, "proposed");
    assert.equal(view.current, v0, "review shows the current skill for the diff");
    assert.deepEqual(view.evidence.map((e: any) => e.session), [c1, c2]);
    assert.ok(view.evidence.every((e: any) => typeof e.message === "number"), "evidence is pointers");
    let r = await post(`/v1/lessons/${lesson.id}/approve`);
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(((await r.json()) as any).status, "applied");
    assert.equal(readFileSync(join(skillsDir, "deploy", "SKILL.md"), "utf8"), v1, "approved skill is live");
    assert.equal((await post(`/v1/lessons/${lesson.id}/approve`)).status, 409, "double approve refused");
    await assert.rejects(L.propose(rt.improver!, { lesson_id: tool!.id, content: v1, must_contain: ["staging"] }), /rejected[\s\S]*Do not propose it again/);
    assert.throws(() => L.dismiss(lesson.id, "noise"), /applied; only the user can roll it back/);
    assert.equal((await post("/v1/lessons/99999/approve")).status, 404);
    ok("HTTP queue: critical proposal shows evidence + current skill; user approve applies with backup; dismissed lesson is never re-proposed");

    // ---- measure: recurrence after apply -> ineffective; twice -> needs code guard ----
    const c3 = await session(["No, I said staging first!"]);
    await rt.learnScan();
    const recur = L.unassigned().find((s) => s.conv === c3)!;
    let after = L.record({ lesson_id: lesson.id, signal_ids: [recur.id] });
    assert.equal(after.status, "ineffective");
    assert.equal(after.failures, 1);
    assert.equal(after.needs_guard, 0);
    const v2 = v1.replace("Deploy to staging first", "Deploy to staging first (always, even for hotfixes)");
    after = await L.propose(rt.improver!, { lesson_id: lesson.id, content: v2, must_contain: ["staging first"] });
    assert.equal(after.status, "applied", "a routine fix is applied at once");
    assert.equal(after.critical, null);
    assert.equal(readFileSync(join(skillsDir, "deploy", "SKILL.md"), "utf8"), v2);
    await sleep(5);
    const c4 = await session(["Wrong, staging first."]);
    await rt.learnScan();
    after = L.record({ lesson_id: lesson.id, signal_ids: [L.unassigned().find((s) => s.conv === c4)!.id] });
    assert.equal(after.status, "ineffective");
    assert.equal(after.needs_guard, 1, "a text rule that failed twice needs a code guard");
    ok("recurrence after apply marks the lesson ineffective; second failure flags a code guard");

    // ---- rollback restores the version before the last apply ----
    r = await post(`/v1/lessons/${lesson.id}/rollback`);
    assert.equal(((await r.json()) as any).status, "retired");
    assert.equal(readFileSync(join(skillsDir, "deploy", "SKILL.md"), "utf8"), v1);
    ok("rollback restores the previous skill version");

    // ---- confirmation: 3 later sessions load the skill with no recurrence ----
    const rule = L.ingest(90003, [{ entry: 1, role: "user", text: "Remember that the staging host is st-1.", ts: Date.now(), calls: [] }], 1);
    let fresh = L.record({ claim: "The staging host is st-1.", cause: "missing", scope: "memory", signal_ids: rule });
    assert.equal(fresh.status, "corroborated", "an explicit user rule counts as evidence");
    await assert.rejects(L.propose(rt.improver!, { lesson_id: fresh.id }), /need `fact`/);
    fresh = await L.propose(rt.improver!, { lesson_id: fresh.id, fact: "The staging host is st-1.", fact_key: "env.staging_host" }, rt.memory);
    assert.equal(fresh.status, "applied");
    assert.ok(rt.memory!.recall("st-1").some((m) => m.key === "env.staging_host"), "routine memory lesson written at once");
    const heldRule = L.ingest(90006, [{ entry: 1, role: "user", text: "Remember that prod deploys need my OK.", ts: Date.now(), calls: [] }], 1);
    let held = L.record({ claim: "Prod deploys need user approval.", cause: "missing", scope: "memory", signal_ids: heldRule });
    held = await L.propose(rt.improver!, { lesson_id: held.id, fact: "Prod deploys need m57's OK.", critical: "changes permission behavior" }, rt.memory);
    assert.equal(held.status, "proposed");
    assert.ok(!rt.memory!.recall("Prod deploys").length, "critical memory lesson waits");
    r = await post(`/v1/lessons/${held.id}/reject`, { note: "already in USER.md" });
    assert.equal(((await r.json()) as any).status, "rejected");
    assert.ok(!rt.memory!.recall("Prod deploys").length);
    ok("memory lessons: explicit rule is enough evidence; routine fact written at once; critical fact waits and user reject drops it");

    const two2 = L.ingest(90004, [{ entry: 1, role: "assistant", text: "", ts: Date.now(), calls: [] }, { entry: 2, role: "user", text: "No, check health first.", ts: Date.now(), calls: [] }], 2);
    const three = L.ingest(90005, [{ entry: 1, role: "assistant", text: "", ts: Date.now(), calls: [] }, { entry: 2, role: "user", text: "No, health check first.", ts: Date.now(), calls: [] }], 2);
    let health = L.record({ claim: "Run the health check after deploy.", cause: "missing", skill: "deploy", signal_ids: [...two2, ...three] });
    const v3 = v1.replace("verify, then production", "run the health check, then production");
    health = await L.propose(rt.improver!, { lesson_id: health.id, content: v3, must_contain: ["health check"] });
    assert.equal(health.status, "applied");
    await sleep(5);
    for (let i = 0; i < 3; i++) await session([]);
    await rt.learnScan();
    assert.equal(L.lesson(health.id)!.status, "confirmed");
    ok("3 later sessions that load the skill without a recurrence confirm the lesson");
    assert.ok(!logs.some((l) => l.startsWith("learn: scan failed")), logs.join("\n"));
  } finally { await rt.close(); }
  console.log("LEARN_OK");
} finally { rmSync(d, { recursive: true, force: true }); }
