// Verifies the web API surface the UI uses: static/PWA files, auth, models, session config (model/thinking/
// instructions), image input validation + delivery to the model, reset/compact, cron CRUD, memory CRUD, skills, children.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vweb-"));
try {
  const cfg = parseConfig({ dataDir: join(d, "data"), cwd: d }, d, {});
  mkdirSync(join(cfg.dataDir, "skills", "demo"), { recursive: true });
  writeFileSync(join(cfg.dataDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill for the UI\n---\nDEMO_BODY\n");
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel();
  const model = { provider: fm.provider, modelId: fm.id };
  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  const app = createApp({ harness: rt.harness, token: "tok", agent: { model }, models: rt.models, store: rt.store, scheduler: rt.scheduler, memory: rt.memory, skillDirs: rt.skillDirs });
  const A = { authorization: "Bearer tok", "content-type": "application/json" };
  const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...A, ...(init.headers as object) } });
  const J = async (path: string, init?: RequestInit) => { const r = await req(path, init); return { status: r.status, body: await r.json() as any }; };

  // static + PWA + auth
  for (const [p, type] of [["/", "text/html"], ["/manifest.webmanifest", "application/manifest+json"], ["/sw.js", "text/javascript"], ["/icon.svg", "image/svg+xml"]] as const) {
    const r = await app.request(p);
    assert.equal(r.status, 200, p); assert.ok(r.headers.get("content-type")!.startsWith(type), p);
  }
  assert.deepEqual(await (await app.request("/health")).json(), { ok: true, auth: true });
  assert.equal((await app.request("/v1/cron")).status, 401);
  ok("page, manifest, service worker, icon served; /v1 requires token; /health hides internals");

  // models
  const ms = await J("/v1/models");
  assert.equal(ms.status, 200); assert.deepEqual(ms.body.default, model); assert.ok(ms.body.models.some((m: any) => m.id === fm.id));
  ok("models list + default");

  // session config
  const { body: { id } } = await J("/v1/sessions", { method: "POST", body: "{}" });
  assert.equal((await J(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ model: { provider: "nope", modelId: "x" } }) })).status, 400);
  assert.equal((await J(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ thinkingLevel: "ultra" }) })).status, 400);
  assert.equal((await J(`/v1/sessions/${id}`, { method: "PATCH", body: JSON.stringify({ thinkingLevel: "high", instructions: "Answer in haiku." }) })).status, 200);
  const s1 = (await J(`/v1/sessions/${id}?limit=1`)).body;
  assert.equal(s1.agent.thinkingLevel, "high"); assert.equal(s1.agent.instructions, "Answer in haiku.");
  ok("PATCH session: model validated, thinking level + instructions stored");

  // image input reaches the model; instructions reach the system prompt
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
  let sawImage = false, sawInstr = false;
  faux.setResponses([(c: any) => {
    const u = [...c.messages].reverse().find((m: any) => m.role === "user");
    sawImage = Array.isArray(u?.content) && u.content.some((b: any) => b.type === "image" && b.data === png);
    sawInstr = JSON.stringify(c.messages.filter((m: any) => m.role === "system")).includes("Answer in haiku.") || String(c.systemPrompt ?? "").includes("Answer in haiku.");
    return fauxAssistantMessage([fauxText("**seen**")]);
  }]);
  assert.equal((await J(`/v1/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content: [{ type: "image", data: "@@", mimeType: "image/png" }] }) })).status, 400);
  assert.equal((await J(`/v1/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content: [{ type: "image", data: png, mimeType: "image/svg+xml" }] }) })).status, 400);
  const sent = await J(`/v1/sessions/${id}/messages`, { method: "POST", body: JSON.stringify({ content: [{ type: "text", text: "what is this" }, { type: "image", data: png, mimeType: "image/png" }] }) });
  assert.equal(sent.body.status, "done", JSON.stringify(sent.body)); assert.equal(sent.body.answer, "**seen**");
  assert.ok(sawImage, "model did not receive the image"); assert.ok(sawInstr, "instructions missing from system prompt");
  const s2 = (await J(`/v1/sessions/${id}?limit=10`)).body;
  assert.ok(s2.usage && Object.keys(s2.usage.models).length, "usage missing");
  ok("image message validated and delivered to model; instructions in prompt; usage reported");

  // reset + compact
  assert.equal((await J(`/v1/sessions/${id}/reset`, { method: "POST" })).status, 200);
  const after = (await J(`/v1/sessions/${id}?limit=5`)).body;
  assert.ok(after.entries.some((e: any) => e.kind === "pi.reset"), "reset entry missing");
  assert.equal((await J(`/v1/sessions/${id}/compact`, { method: "POST" })).status, 202);
  ok("reset writes pi.reset; compact accepted");

  // cron CRUD
  assert.equal((await J("/v1/cron", { method: "POST", body: JSON.stringify({ name: "x", expr: "bad", prompt: "p" }) })).status, 400);
  const job = (await J("/v1/cron", { method: "POST", body: JSON.stringify({ name: "daily", expr: "@daily", prompt: "say hi" }) })).body;
  assert.ok(job.id && job.nextRun);
  assert.equal((await J("/v1/cron", { method: "POST", body: JSON.stringify({ name: "daily", expr: "@daily", prompt: "say hi" }) })).status, 409);
  assert.equal((await J(`/v1/cron/${job.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) })).status, 200);
  const cl = (await J("/v1/cron")).body;
  assert.equal(cl.jobs.find((j: any) => j.id === job.id).enabled, false);
  assert.equal((await J(`/v1/cron/${job.id}`, { method: "DELETE" })).status, 200);
  assert.ok(!(await J("/v1/cron")).body.jobs.some((j: any) => j.id === job.id));
  ok("cron: create (validated, unique), disable, list, delete");

  // memory CRUD
  const mem = (await J("/v1/memory", { method: "POST", body: JSON.stringify({ key: "user.city", content: "As-Salt" }) })).body;
  assert.equal((await J("/v1/memory?q=salt")).body.items[0].id, mem.id);
  assert.equal((await J("/v1/memory", { method: "POST", body: JSON.stringify({ content: "  " }) })).status, 400);
  assert.equal((await J(`/v1/memory/${mem.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await J("/v1/memory?q=salt")).body.items.length, 0);
  ok("memory: remember, search, validation, forget");

  // skills
  const sk = (await J("/v1/skills")).body.skills;
  assert.ok(sk.some((s: any) => s.name === "demo" && s.description === "A demo skill for the UI"));
  assert.match((await J("/v1/skills/demo")).body.body, /DEMO_BODY/);
  assert.equal((await J("/v1/skills/nope")).status, 404);
  ok("skills: list + body");

  // children appear on the parent; hidden from session list
  const p = (await J("/v1/sessions", { method: "POST", body: "{}" })).body.id;
  let step = 0;
  faux.setResponses(Array(6).fill((c: any) => {
    const isParent = c.messages.some((m: any) => m.role === "user" && (typeof m.content === "string" ? m.content : "") === "delegate");
    if (!isParent) return fauxAssistantMessage([fauxText("child done")]);
    return step++ === 0 ? fauxAssistantMessage([fauxToolCall("delegate_task", { action: "spawn", task: "sub job" })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("ok")]);
  }));
  assert.equal((await J(`/v1/sessions/${p}/messages`, { method: "POST", body: JSON.stringify({ content: "delegate" }) })).body.status, "done");
  await rt.harness.waitForIdle(context);
  const ps = (await J(`/v1/sessions/${p}?limit=1`)).body;
  assert.equal(ps.children.length, 1); assert.equal(ps.children[0].task, "sub job");
  const list = (await J("/v1/sessions")).body.sessions.map((s: any) => s.id);
  assert.ok(list.includes(p) && !list.includes(ps.children[0].id), "child should be hidden from list");
  ok("subagent children listed on parent, hidden from session list");

  await rt.close();
  console.log("WEB_OK");
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
