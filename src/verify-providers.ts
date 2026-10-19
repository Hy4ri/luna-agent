// Verifies provider management end to end through the HTTP API the web UI uses:
// file credential store (0600, persists), API-key save/disconnect, interactive OAuth login (select prompt,
// auth_url event, manual code), custom OpenAI-compatible provider (auto-detect + a real streamed chat turn
// against a local fake server), default model persistence, and /v1/models listing only connected providers.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createModels, createProvider, fauxProvider, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { parseConfig } from "./config.js";
import { FileCredentialStore, ProviderManager } from "./providers.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vprov-"));

// Fake OpenAI-compatible server: GET /v1/models, POST /v1/chat/completions (streamed). Records the auth header.
let seenAuth = "";
const fake = createServer((req, res) => {
  if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); return void res.end(JSON.stringify({ data: [{ id: "tiny-1", context_length: 1000000, top_provider: { max_completion_tokens: 64000 } }, { id: "tiny-2" }] })); }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    seenAuth = String(req.headers.authorization ?? "");
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "tiny-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "hello from " }, null));
      res.write(chunk({ content: "tiny" }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
    return;
  }
  res.writeHead(404).end();
}).listen(0, "127.0.0.1");
await new Promise((r) => fake.once("listening", r));
const base = `http://127.0.0.1:${(fake.address() as { port: number }).port}/v1`;

try {
  // ---- file credential store ----
  const store = new FileCredentialStore(join(d, "auth.json"));
  await store.modify("x", async () => ({ type: "api_key", key: "k1" }));
  assert.equal((statSync(join(d, "auth.json")).mode & 0o777).toString(8), "600");
  assert.deepEqual(await new FileCredentialStore(join(d, "auth.json")).read("x"), { type: "api_key", key: "k1" });
  await store.delete("x");
  assert.equal(await store.read("x"), undefined);
  ok("file credential store: 0600, persists across instances, delete");

  // ---- runtime with real file-backed models + a fake OAuth provider ----
  const cfg = parseConfig({ dataDir: join(d, "data"), cwd: d, extensions: ["coding", "memory"] }, d, {});
  const models: MutableModels = createModels({ credentials: new FileCredentialStore(join(cfg.dataDir, "auth.json")) });
  const faux = fauxProvider(); models.setProvider(faux.provider);
  const fm = faux.getModel();
  const answers: string[] = [];
  models.setProvider(createProvider({
    id: "subby", name: "Subby",
    auth: {
      oauth: {
        name: "Subby (Pro plan)", isSubscription: true, loginLabel: "Sign in with Subby",
        async login(it) {
          const how = await it.prompt({ type: "select", message: "Method?", options: [{ id: "browser", label: "Browser" }, { id: "code", label: "Paste code" }] });
          answers.push(how);
          it.notify({ type: "auth_url", url: "https://subby.example/authorize?x=1", instructions: "sign in" });
          const code = await it.prompt({ type: "manual_code", message: "Paste the code", placeholder: "code#state" });
          answers.push(code);
          if (code !== "good#state") throw new Error("bad code");
          return { type: "oauth", access: "acc-" + code, refresh: "ref", expires: Date.now() + 3_600_000 };
        },
        refresh: async (c) => c,
        toAuth: async (c) => ({ apiKey: c.access }),
      },
    },
    models: [{ id: "s1", name: "Subby One", api: "openai-completions", provider: "subby", baseUrl: base, input: ["text"], reasoning: false, contextWindow: 8000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    api: openAICompletionsApi(),
  }));
  const rt = await startRuntime(cfg, { models, model: { provider: fm.provider, modelId: fm.id }, log: () => {} });
  const app = createApp({ harness: rt.harness, token: "tok", agent: { model: rt.model }, models: rt.models, providers: rt.providers });
  const req = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: "Bearer tok", "content-type": "application/json", ...(init.headers as object) } });
  const J = async (path: string, init?: RequestInit) => { const r = await req(path, init); return { status: r.status, body: await r.json() as any }; };
  const send = (method: string, body?: unknown) => ({ method, body: JSON.stringify(body ?? {}) });

  assert.equal((await app.request("/v1/providers")).status, 401);
  let pv = (await J("/v1/providers")).body;
  const by = (id: string) => pv.providers.find((p: any) => p.id === id);
  for (const id of ["anthropic", "openai", "github-copilot", "openrouter", "subby"]) assert.ok(by(id), "missing provider " + id);
  assert.equal(by("anthropic").oauth.subscription, true);
  assert.equal(by("openai").oauth.label, "Sign in with ChatGPT");
  assert.equal(by("subby").connected, false);
  ok("providers listed: built-ins with subscription OAuth (Anthropic Pro/Max, ChatGPT, Copilot) + API keys");

  // /v1/models: only connected providers (faux is keyless) — no anthropic models before a key.
  let ms = (await J("/v1/models")).body;
  assert.ok(ms.models.some((m: any) => m.provider === "faux"));
  assert.ok(!ms.models.some((m: any) => m.provider === "anthropic"), "unconnected provider leaked into /v1/models");
  ok("/v1/models lists only connected providers");

  // ---- API key save / disconnect (env var cleared so the stored key is what connects it) ----
  const envKey = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_OAUTH_TOKEN;
  assert.equal((await J("/v1/providers/anthropic/key", send("PUT", { key: "" }))).status, 400);
  assert.equal((await J("/v1/providers/anthropic/key", send("PUT", { key: "sk-ant-test" }))).status, 200);
  pv = (await J("/v1/providers")).body;
  assert.equal(by("anthropic").connected, true); assert.equal(by("anthropic").via, "api_key"); assert.equal(by("anthropic").source, "stored credential");
  assert.deepEqual(JSON.parse(readFileSync(join(cfg.dataDir, "auth.json"), "utf8")).anthropic, { type: "api_key", key: "sk-ant-test" });
  ms = (await J("/v1/models")).body;
  assert.ok(ms.models.some((m: any) => m.provider === "anthropic"), "anthropic models missing after key");
  assert.equal((await J("/v1/providers/anthropic/credential", send("DELETE"))).status, 200);
  pv = (await J("/v1/providers")).body;
  assert.equal(by("anthropic").connected, false);
  if (envKey) process.env.ANTHROPIC_API_KEY = envKey;
  ok("API key: saved to auth.json, provider connects and lists models, disconnect removes it");

  // ---- interactive OAuth login through the API ----
  const poll = async (id: string, until: (l: any) => boolean) => {
    for (let i = 0; i < 100; i++) { const l = (await J(`/v1/logins/${id}`)).body; if (until(l)) return l; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error("login poll timed out");
  };
  assert.equal((await J("/v1/providers/faux/login", send("POST", { type: "oauth" }))).status, 400);
  const start = await J("/v1/providers/subby/login", send("POST", { type: "oauth" }));
  assert.equal(start.status, 201);
  let l = await poll(start.body.id, (x) => x.prompt?.type === "select");
  assert.deepEqual(l.prompt.options.map((o: any) => o.id), ["browser", "code"]);
  assert.equal((await J(`/v1/logins/${l.id}/answer`, send("POST", { seq: 999, value: "code" }))).status, 409, "stale seq must be rejected");
  assert.equal((await J(`/v1/logins/${l.id}/answer`, send("POST", { seq: l.prompt.seq, value: "code" }))).status, 200);
  l = await poll(l.id, (x) => x.prompt?.type === "manual_code");
  assert.equal(l.events[0].type, "auth_url"); assert.equal(l.events[0].url, "https://subby.example/authorize?x=1");
  await J(`/v1/logins/${l.id}/answer`, send("POST", { seq: l.prompt.seq, value: "good#state" }));
  l = await poll(l.id, (x) => x.status !== "running");
  assert.equal(l.status, "done", JSON.stringify(l));
  assert.deepEqual(answers, ["code", "good#state"]);
  pv = (await J("/v1/providers")).body;
  assert.equal(by("subby").connected, true); assert.equal(by("subby").via, "oauth");
  const saved = JSON.parse(readFileSync(join(cfg.dataDir, "auth.json"), "utf8")).subby;
  assert.equal(saved.type, "oauth"); assert.equal(saved.access, "acc-good#state");
  ok("OAuth login via API: select prompt, auth_url event, manual code, stale answer rejected, token stored");

  // a failing login reports the error; cancel works
  const bad = (await J("/v1/providers/subby/login", send("POST", { type: "oauth" }))).body;
  let b = await poll(bad.id, (x) => x.prompt?.type === "select");
  await J(`/v1/logins/${b.id}/answer`, send("POST", { seq: b.prompt.seq, value: "code" }));
  b = await poll(b.id, (x) => x.prompt?.type === "manual_code");
  await J(`/v1/logins/${b.id}/answer`, send("POST", { seq: b.prompt.seq, value: "wrong" }));
  b = await poll(b.id, (x) => x.status !== "running");
  assert.equal(b.status, "error"); assert.match(b.error, /bad code/);
  const c2 = (await J("/v1/providers/subby/login", send("POST", { type: "oauth" }))).body;
  await poll(c2.id, (x) => x.prompt);
  await J(`/v1/logins/${c2.id}`, send("DELETE"));
  assert.equal((await poll(c2.id, (x) => x.status !== "running")).status, "cancelled");
  ok("failed login reports its error; cancel stops a running login");

  // ---- subscription-connected model answers a real chat turn (OAuth access token sent as bearer) ----
  const sid = (await J("/v1/sessions", send("POST", { model: { provider: "subby", modelId: "s1" } }))).body.id;
  const turn = await J(`/v1/sessions/${sid}/messages`, send("POST", { content: "hi" }));
  assert.equal(turn.body.status, "done", JSON.stringify(turn.body));
  assert.equal(turn.body.answer, "hello from tiny");
  assert.equal(seenAuth, "Bearer acc-good#state");
  ok("OAuth-connected model streamed a real turn; access token sent as bearer");

  // ---- custom OpenAI-compatible provider: validation, auto-detect, chat, default model, removal ----
  assert.equal((await J("/v1/providers/custom", send("POST", { id: "Bad Id", baseUrl: base }))).status, 400);
  assert.equal((await J("/v1/providers/custom", send("POST", { id: "x1", baseUrl: "ftp://nope" }))).status, 400);
  assert.equal((await J("/v1/providers/custom", send("POST", { id: "anthropic", baseUrl: base }))).status, 400);
  assert.equal((await J("/v1/providers/custom", send("POST", { id: "x2", api: "anthropic-messages", baseUrl: base }))).status, 400, "anthropic api needs model ids");
  const add = await J("/v1/providers/custom", send("POST", { id: "local", name: "Local LLM", baseUrl: base + "/", key: "sk-local" }));
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.deepEqual(add.body.models.map((m: any) => m.id), ["tiny-1", "tiny-2"]);
  assert.deepEqual(add.body.models, [{ id: "tiny-1", contextWindow: 1000000, maxTokens: 64000 }, { id: "tiny-2" }], "reported limits are saved");
  pv = (await J("/v1/providers")).body;
  assert.equal(by("local").custom, true); assert.equal(by("local").connected, true); assert.equal(by("local").models, 2);
  ms = (await J("/v1/models")).body;
  assert.ok(ms.models.some((m: any) => m.provider === "local" && m.id === "tiny-2"));
  ok("custom provider: validation, auto-detected models from /models, connected, listed");

  assert.equal((await J("/v1/models/default", send("PUT", { provider: "local", modelId: "nope" }))).status, 400);
  assert.equal((await J("/v1/models/default", send("PUT", { provider: "local", modelId: "tiny-1" }))).status, 200);
  assert.deepEqual((await J("/v1/models")).body.default, { provider: "local", modelId: "tiny-1" });
  const s2 = (await J("/v1/sessions", send("POST", {}))).body.id;
  assert.deepEqual((await J(`/v1/sessions/${s2}?limit=1`)).body.agent.model, { provider: "local", modelId: "tiny-1" }, "new session must use saved default");
  seenAuth = "";
  const t2 = await J(`/v1/sessions/${s2}/messages`, send("POST", { content: "hey" }));
  assert.equal(t2.body.answer, "hello from tiny"); assert.equal(seenAuth, "Bearer sk-local");
  ok("default model saved; new sessions use it; custom endpoint answered with its key");

  // persisted: a fresh manager over the same dataDir restores custom providers + default + credentials
  const again = new ProviderManager({ dataDir: cfg.dataDir, fallbackModel: { provider: "faux", modelId: "x" } });
  assert.deepEqual(again.defaultModel(), { provider: "local", modelId: "tiny-1" });
  assert.ok(again.models.getModel("local", "tiny-2"));
  assert.equal((await again.models.checkAuth("local"))?.type, "api_key");
  assert.equal((await again.models.checkAuth("subby").catch(() => undefined)), undefined, "subby is a test-only provider, not restored");
  ok("providers.json + auth.json restore custom providers, default model and keys after restart");

  // A provider saved before limits were detected picks them up on refresh; a saved value still wins.
  const legacyDir = mkdtempSync(join(d, "legacy-"));
  writeFileSync(join(legacyDir, "providers.json"), JSON.stringify({ custom: [{ id: "old", name: "Old", api: "openai-completions", baseUrl: base,
    models: [{ id: "tiny-1" }, { id: "tiny-2" }, { id: "pinned", contextWindow: 32000 }] }] }));
  writeFileSync(join(legacyDir, "auth.json"), JSON.stringify({ old: { type: "api_key", key: "sk-old" } }), { mode: 0o600 });
  const legacy = new ProviderManager({ dataDir: legacyDir, fallbackModel: { provider: "faux", modelId: "x" } });
  assert.equal(legacy.models.getModel("old", "tiny-1")!.contextWindow, 128000);
  assert.deepEqual(legacy.customIds(), ["old"]);
  const refreshed = await legacy.models.refresh({ providers: legacy.customIds(), allowNetwork: true });
  assert.equal(refreshed.errors.size, 0, [...refreshed.errors.values()].join());
  assert.equal(legacy.models.getModel("old", "tiny-1")!.contextWindow, 1000000);
  assert.equal(legacy.models.getModel("old", "tiny-1")!.maxTokens, 64000);
  assert.equal(legacy.models.getModel("old", "tiny-2")!.contextWindow, 128000, "no reported window keeps the fallback");
  assert.equal(legacy.models.getModel("old", "pinned")!.contextWindow, 32000, "saved window wins");
  ok("refresh applies endpoint-reported context windows to saved custom models");

  assert.equal((await J("/v1/providers/custom/anthropic", send("DELETE"))).status, 400);
  assert.equal((await J("/v1/providers/custom/local", send("DELETE"))).status, 200);
  pv = (await J("/v1/providers")).body;
  assert.equal(by("local"), undefined);
  assert.deepEqual((await J("/v1/models")).body.default, { provider: fm.provider, modelId: fm.id }, "default falls back after its provider is removed");
  assert.equal(JSON.parse(readFileSync(join(cfg.dataDir, "auth.json"), "utf8")).local, undefined);
  ok("removing a custom provider drops its key and resets the default");

  await rt.close();
  console.log("PROVIDERS_OK");
} finally {
  fake.closeAllConnections(); fake.close();
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
