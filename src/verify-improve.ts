// Verifies the self-improvement loop: real cron.db failures -> lessons -> model drafts skill -> benchmark gates -> rollback,
// and that the skills extension then serves the new skill.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { context, createModels, openLuna } from "./luna.js";
import { CronStore } from "./scheduler.js";
import { containsBenchmark, createImproveExtension, cronRunSource, SkillImprover, signature } from "./improve.js";
import { scanSkills } from "./skills.js";

const d = mkdtempSync(join(process.cwd(), ".vimp-"));
try {
  // seed a real cron.db through CronStore's schema
  const cron = new CronStore(join(d, "cron.db"));
  const j = cron.db.prepare("INSERT INTO jobs(name,expr,prompt,created_at) VALUES('nightly','* * * * *','p',1)").run().lastInsertRowid;
  const ins = cron.db.prepare("INSERT INTO runs(job_id,slot,started_at,status,error,output) VALUES(?,?,?,?,?,?)");
  ins.run(j, 1, 100, "error", "ECONNREFUSED connecting to 10.0.0.5:5432\n at foo", null);
  ins.run(j, 2, 200, "error", "ECONNREFUSED connecting to 10.0.0.9:5432\n at bar", null);
  ins.run(j, 3, 300, "error", "ECONNREFUSED connecting to 10.0.0.7:5432", null);
  ins.run(j, 4, 400, "error", "one-off weird failure", null);
  ins.run(j, 5, 500, "ok", null, "fine");
  cron.db.close();

  const skills = join(d, "skills");
  const imp = new SkillImprover({ skillsDir: skills, sources: [cronRunSource(join(d, "cron.db"))] });

  // inspect + lessons
  assert.equal(imp.inspectRuns().length, 5);
  assert.equal(imp.inspectRuns({ status: "error" }).length, 4);
  const ls = imp.lessons();
  assert.equal(ls.length, 1); assert.equal(ls[0]!.count, 3); assert.deepEqual(ls[0]!.labels, ["nightly"]);
  assert.equal(signature("ECONNREFUSED connecting to 10.0.0.5:5432"), signature("ECONNREFUSED connecting to 10.0.0.9:5432"));
  console.log("OK inspect + lesson extraction:", ls[0]!.signature);

  const v1 = "---\nname: db-retry\ndescription: Handle ECONNREFUSED database failures in jobs\n---\nRetry with backoff. Check the db host is up first.\n";
  const v2 = v1 + "Always log the host and port when connection is refused.\n";
  const bench = containsBenchmark(["backoff", "host"]);

  // lint gate
  let r = await imp.propose("db-retry", "no frontmatter", bench);
  assert.equal(r.applied, false); assert.ok(r.lint.length);
  assert.ok(!existsSync(join(skills, "db-retry")));
  // create
  r = await imp.propose("db-retry", v1, bench);
  assert.ok(r.applied && r.created && r.candidate!.score === 1, JSON.stringify(r));
  // regression blocked (drops "host")
  const bad = "---\nname: db-retry\ndescription: Handle ECONNREFUSED database failures in jobs\n---\nJust retry with backoff, whatever.\n";
  r = await imp.propose("db-retry", bad, bench);
  assert.ok(!r.applied && r.reason.startsWith("regression"), JSON.stringify(r));
  assert.equal(readFileSync(join(skills, "db-retry", "SKILL.md"), "utf8"), v1);
  // dry run doesn't write
  r = await imp.propose("db-retry", v2, bench, true);
  assert.ok(!r.applied && readFileSync(join(skills, "db-retry", "SKILL.md"), "utf8") === v1);
  // improvement applied, backup kept
  r = await imp.propose("db-retry", v2, bench);
  assert.ok(r.applied && r.version === 1, JSON.stringify(r));
  assert.equal(readFileSync(join(skills, "db-retry", "SKILL.md"), "utf8"), v2);
  assert.deepEqual(imp.versions("db-retry"), [1]);
  // rollback
  imp.rollback("db-retry", 1);
  assert.equal(readFileSync(join(skills, "db-retry", "SKILL.md"), "utf8"), v1);
  assert.throws(() => imp.rollback("db-retry", 99));
  // bad names / traversal
  await assert.rejects(imp.propose("../evil", v1));
  // command benchmark
  const cmdOk = await imp.propose("db-retry", v2, undefined, true);
  assert.ok(cmdOk.reason.includes("dry"));
  console.log("OK lint gate, regression block, dry run, apply+backup, rollback, name validation");

  // end to end through the harness: model inspects, extracts, proposes (with must_contain), then loads the skill
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const imp2 = new SkillImprover({ skillsDir: skills, sources: [cronRunSource(join(d, "cron.db"))] });
  const harness = await openLuna({ dbPath: join(d, "luna.db"), memory: join(d, "m.db"), models, cwd: d, skillDirs: [skills], extensions: [createImproveExtension(imp2)] });
  const m = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });
  const results: string[] = [];
  const grab = (c: any) => { results.length = 0; for (const x of c.messages ?? []) if (x.role === "toolResult") results.push(JSON.stringify(x.content)); };
  const newSkill = "---\nname: pg-timeouts\ndescription: Diagnose postgres connection refusals seen in scheduled jobs\n---\nCheck the server is listening before retrying; use exponential backoff.\n";
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("inspect_runs", { status: "error" }), fauxToolCall("extract_lessons", {})], { stopReason: "toolUse" }),
    (c: any) => { grab(c); return fauxAssistantMessage([fauxToolCall("skill_propose", { name: "pg-timeouts", content: newSkill, must_contain: ["backoff", "listening"] })], { stopReason: "toolUse" }); },
    (c: any) => { grab(c); return fauxAssistantMessage([fauxToolCall("skill_propose", { name: "pg-timeouts", content: newSkill + "x", must_contain: ["nonexistent phrase"] })], { stopReason: "toolUse" }); },
    (c: any) => { grab(c); return fauxAssistantMessage([fauxToolCall("skill_view", { name: "pg-timeouts" })], { stopReason: "toolUse" }); },
    (c: any) => { grab(c); return fauxAssistantMessage([fauxText("done")]); },
  ]);
  const sub = await root.submit({ type: "input", content: "improve yourself" }, context);
  const settled: any = await sub.wait(context);
  assert.equal(settled.status, "done", JSON.stringify(settled).slice(0, 300));
  await root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), context);
  await harness.close(context);
  const final = results.join("\n");
  assert.ok(final.includes("exponential backoff"), "skill_view served drafted skill: " + final.slice(0, 300));
  assert.equal(readFileSync(join(skills, "pg-timeouts", "SKILL.md"), "utf8"), newSkill, "failing benchmark did not overwrite");
  assert.ok(scanSkills([skills]).some((s) => s.name === "pg-timeouts"));
  console.log("OK end to end via harness: inspect -> lessons -> propose (applied) -> failing propose blocked -> skill_view serves it");
  console.log("ALL_OK");
} finally {
  rmSync(d, { recursive: true, force: true });
}
