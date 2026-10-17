import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";

const dir = mkdtempSync(join(process.cwd(), ".projects-test-"));
try {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  const rt = await startRuntime(loadConfig(configPath), { models, model: { provider: m.provider, modelId: m.id } });
  try {
    const app = createApp({ harness: rt.harness, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations,
      agent: { model: { provider: m.provider, modelId: m.id } }, token: "t" });
    const headers = { authorization: "Bearer t", "content-type": "application/json" };
    const call = (path: string, method = "GET", body?: unknown) => app.request(path, { method, headers, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const proj = join(dir, "proj-a"), other = join(dir, "proj-b"); mkdirSync(proj); mkdirSync(other);

    // Validation
    assert.equal((await call("/v1/projects", "POST", { name: "", cwd: proj })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: "relative/dir" })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: join(dir, "missing") })).status, 400);
    assert.equal((await call("/v1/projects", "POST", { name: "x", cwd: configPath })).status, 400);

    // Create, duplicate, list
    const created = await call("/v1/projects", "POST", { name: "Alpha", cwd: proj });
    assert.equal(created.status, 201);
    const a = await created.json() as { id: number; cwd: string };
    assert.equal(a.cwd, proj);
    assert.equal((await call("/v1/projects", "POST", { name: "alpha", cwd: other })).status, 409);
    assert.equal(((await (await call("/v1/projects")).json()) as { projects: unknown[] }).projects.length, 1);

    // A session in the project starts in the project directory; a normal session is unaffected.
    const normal = await (await call("/v1/sessions", "POST", {})).json() as { id: number };
    const inProj = await (await call("/v1/sessions", "POST", { project: a.id })).json() as { id: number };
    const cwdOf = async (id: number) => ((await (await call(`/v1/sessions/${id}`)).json()) as { agent: { cwd: string | null } }).agent.cwd;
    assert.equal(await cwdOf(inProj.id), proj);
    assert.notEqual(await cwdOf(normal.id), proj);
    // An explicit cwd wins over the project default.
    const explicit = await (await call("/v1/sessions", "POST", { project: a.id, cwd: other })).json() as { id: number };
    assert.equal(await cwdOf(explicit.id), other);
    assert.equal((await call("/v1/sessions", "POST", { project: 999 })).status, 400);

    // The session list reports the link.
    const list = (await (await call("/v1/sessions")).json() as { sessions: { id: number; project: number | null }[] }).sessions;
    assert.equal(list.find(s => s.id === inProj.id)?.project, a.id);
    assert.equal(list.find(s => s.id === normal.id)?.project, null);

    // Editing a project changes new sessions only.
    assert.equal((await call(`/v1/projects/${a.id}`, "PATCH", { cwd: other })).status, 200);
    assert.equal(await cwdOf(inProj.id), proj);
    const later = await (await call("/v1/sessions", "POST", { project: a.id })).json() as { id: number };
    assert.equal(await cwdOf(later.id), other);
    assert.equal((await call("/v1/projects/999", "PATCH", { name: "z" })).status, 404);

    // Deleting a project keeps its sessions and their directory, and clears the link.
    assert.equal((await call(`/v1/projects/${a.id}`, "DELETE")).status, 200);
    assert.equal((await call(`/v1/projects/${a.id}`, "DELETE")).status, 404);
    assert.equal(await cwdOf(inProj.id), proj);
    const after = (await (await call("/v1/sessions")).json() as { sessions: { id: number; project: number | null }[] }).sessions;
    assert.equal(after.find(s => s.id === inProj.id)?.project, null);

    // Auth
    assert.equal((await app.request("/v1/projects")).status, 401);
    console.log("PROJECTS_OK");
  } finally { await rt.close?.(); }
} finally { rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
