import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import {
  formatRequest, matches, render, RETRY_DELAYS_MS, sign, verifyRequest, WebhookStore, Webhooks,
  type InboundTarget, type WebhookTargets,
} from "../src/webhooks.js";

const enc = (s: string) => new TextEncoder().encode(s);
const hdr = (h: Record<string, string>) => (k: string) => h[k.toLowerCase()];
const noQuery = () => undefined;

function fakeTargets() {
  const calls: { kind: string; id: number; content?: string; requestId?: string; title?: string }[] = [];
  const t: WebhookTargets = {
    async toSession(id, content, requestId) { calls.push({ kind: "session", id, content, requestId }); return id !== 404; },
    async newSession(project, title, content, requestId) { calls.push({ kind: "project", id: project, title, content, requestId }); return 77; },
    async runCron(id) { calls.push({ kind: "cron", id }); return 5; },
    async exists(x: InboundTarget) { return x.id !== 999; },
  };
  return { t, calls };
}

test("verifyRequest: HMAC and token checks pass only with the right secret", () => {
  const body = enc('{"a":1}');
  const good = `sha256=${sign("s3cret", body)}`;
  assert.equal(verifyRequest("hmac", "s3cret", body, hdr({ "x-hub-signature-256": good }), noQuery), true);
  assert.equal(verifyRequest("hmac", "s3cret", body, hdr({ "x-signature": sign("s3cret", body).toUpperCase() }), noQuery), true);
  assert.equal(verifyRequest("hmac", "other", body, hdr({ "x-hub-signature-256": good }), noQuery), false);
  assert.equal(verifyRequest("hmac", "s3cret", enc('{"a":2}'), hdr({ "x-hub-signature-256": good }), noQuery), false);
  assert.equal(verifyRequest("hmac", "s3cret", body, hdr({}), noQuery), false);
  assert.equal(verifyRequest("hmac", "s3cret", body, hdr({ "x-hub-signature-256": "sha256=abc" }), noQuery), false);
  assert.equal(verifyRequest("token", "tok", body, hdr({ authorization: "Bearer tok" }), noQuery), true);
  assert.equal(verifyRequest("token", "tok", body, hdr({ "x-gitlab-token": "tok" }), noQuery), true);
  assert.equal(verifyRequest("token", "tok", body, hdr({}), k => (k === "token" ? "tok" : undefined)), true);
  assert.equal(verifyRequest("token", "tok", body, hdr({ authorization: "Bearer nope" }), noQuery), false);
  // A token hook never accepts a signature, and the reverse.
  assert.equal(verifyRequest("token", "tok", body, hdr({ "x-hub-signature-256": `sha256=${sign("tok", body)}` }), noQuery), false);
});

test("matches, render and formatRequest", () => {
  assert.equal(matches([], "push"), true);
  assert.equal(matches(["push"], "push"), true);
  assert.equal(matches(["pull_request.opened"], "pull_request", "opened"), true);
  assert.equal(matches(["pull_request.opened"], "pull_request", "closed"), false);
  assert.equal(matches(["session.*"], "session.failed"), true);
  assert.equal(matches(["cron.*"], "session.failed"), false);
  assert.equal(matches(["*"], null), true);
  assert.equal(matches(["push"], null), false);

  const out = render("{{event}}/{{action}}: {{body.pull_request.title}} by {{ body.user.login }} {{headers.x-github-event}} {{body.missing}}|{{body.n}}", {
    body: { pull_request: { title: "Fix" }, user: { login: "m57" }, n: 0 }, headers: { "x-github-event": "pull_request" },
    event: "pull_request", action: "opened", delivery: "d1", hook: "gh", payload: "{}",
  });
  assert.equal(out, "pull_request/opened: Fix by m57 pull_request |0");

  const env = { id: "evt_1", event: "session.failed", createdAt: "2026-01-01T00:00:00.000Z", data: { title: "Sessión 3", text: "boom" } };
  assert.deepEqual(JSON.parse(formatRequest("json", env).body), env);
  const ntfy = formatRequest("ntfy", env);
  assert.equal(ntfy.body, "boom");
  assert.match(ntfy.headers.Title!, /^=\?UTF-8\?B\?/);
  assert.equal(JSON.parse(formatRequest("discord", env).body).content, "**Sessión 3**\nboom");
  assert.equal(JSON.parse(formatRequest("slack", env).body).text, "*Sessión 3*\nboom");
});

test("inbound: signature, filter, dedupe, rate limit, targets and log", async () => {
  const store = new WebhookStore(":memory:");
  const { t, calls } = fakeTargets();
  let clock = 1_000_000;
  const w = new Webhooks(store, { targets: () => t, clock: () => clock });
  const { hook, secret } = store.createInbound({ name: "GitHub", target: { kind: "project", id: 0 }, events: ["pull_request.opened", "issues"],
    template: "PR {{body.number}}: {{body.title}}" });
  assert.match(secret, /^whsec_/);
  assert.equal(JSON.stringify(store.listInbound()).includes(secret), false, "list never shows the secret");

  const send = (body: string, h: Record<string, string> = {}, s = secret) =>
    w.receive(hook.slug, enc(body), hdr({ "x-hub-signature-256": `sha256=${sign(s, enc(body))}`, ...h }), noQuery);

  assert.equal((await w.receive("nope", enc("{}"), hdr({}), noQuery)).status, 404);
  assert.equal((await send('{"action":"opened"}', { "x-github-event": "pull_request" }, "wrong")).status, 401);
  assert.equal((await send("{}", { "x-github-event": "ping" })).status, 200);

  const ok = await send('{"action":"opened","number":7,"title":"Add hooks"}', { "x-github-event": "pull_request", "x-github-delivery": "D1" });
  assert.equal(ok.status, 202);
  assert.equal(ok.body.sessionId, 77);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.title, "GitHub: pull_request.opened");
  assert.match(calls[0]!.content!, /untrusted data/);
  assert.match(calls[0]!.content!, /PR 7: Add hooks/);
  assert.equal(calls[0]!.requestId, `webhook:${hook.id}:D1`);

  const dup = await send('{"action":"opened","number":7,"title":"Add hooks"}', { "x-github-event": "pull_request", "x-github-delivery": "D1" });
  assert.deepEqual([dup.status, dup.body.duplicate, dup.body.sessionId], [200, true, 77]);
  assert.equal(calls.length, 1, "a redelivered id does not run twice");

  const ign = await send('{"action":"closed"}', { "x-github-event": "pull_request", "x-github-delivery": "D2" });
  assert.deepEqual([ign.status, ign.body.ignored], [202, true]);
  assert.equal(calls.length, 1);

  // A rejected delivery id can still succeed later (the sender retries after a secret fix).
  assert.equal((await send('{"x":1}', { "x-github-event": "issues", "x-github-delivery": "D3" }, "wrong")).status, 401);
  assert.equal((await send('{"x":1}', { "x-github-event": "issues", "x-github-delivery": "D3" })).status, 202);

  const log = store.inboundLog(hook.id);
  assert.deepEqual(log.map(l => l.outcome), ["delivered", "rejected", "ignored", "duplicate", "delivered", "rejected"]);
  assert.equal(store.getInbound(hook.id)!.received, 2);

  // Rate limit: 60 per minute per hook.
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await send('{"n":1}', { "x-github-event": "issues" })).status === 429) limited++;
  assert.ok(limited >= 10, `limited ${limited}`);
  clock += 61_000;
  assert.equal((await send('{"n":1}', { "x-github-event": "issues" })).status, 202);

  // Session target that vanished: 410. Cron target: run id.
  const gone = store.createInbound({ name: "gone", target: { kind: "session", id: 404 }, verify: "token" });
  assert.equal((await w.receive(gone.hook.slug, enc("hi"), hdr({ authorization: `Bearer ${gone.secret}` }), noQuery)).status, 410);
  const cron = store.createInbound({ name: "cron", target: { kind: "cron", id: 3 }, verify: "token" });
  const r = await w.receive(cron.hook.slug, enc("go"), hdr({ "x-webhook-token": cron.secret }), noQuery);
  assert.deepEqual([r.status, r.body.runId], [202, 5]);

  // Disabled and rotated hooks.
  store.updateInbound(cron.hook.id, { enabled: false });
  assert.equal((await w.receive(cron.hook.slug, enc("go"), hdr({ "x-webhook-token": cron.secret }), noQuery)).status, 404);
  const fresh = store.rotateInbound(gone.hook.id);
  assert.notEqual(fresh, gone.secret);
  assert.equal((await w.receive(gone.hook.slug, enc("hi"), hdr({ authorization: `Bearer ${gone.secret}` }), noQuery)).status, 401);

  await assert.rejects(w.checkTarget({ kind: "session", id: 999 }), /no such session 999/);
  await assert.rejects(w.checkTarget({ kind: "bogus", id: 1 }), /target must be/);
  await w.close();
  store.close();
});

test("outbound: signed delivery, retry backoff, give-up, 410 and outbox survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-webhooks-"));
  const path = join(dir, "webhooks.db");
  try {
    let clock = 5_000_000;
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    let reply = 500;
    const fetchFake = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response(reply === 204 ? null : "nope", { status: reply });
    }) as unknown as typeof fetch;
    let store = new WebhookStore(path);
    let w = new Webhooks(store, { targets: () => undefined, fetch: fetchFake, clock: () => clock });
    const { sub, secret } = store.createSub({ name: "ci", url: "https://example.test/hook", events: ["session.*"] });
    assert.throws(() => store.createSub({ name: "x", url: "ftp://x", events: [] }), /http\(s\) URL/);
    assert.throws(() => store.createSub({ name: "x", url: "https://x", events: ["nope.event"] }), /unknown event/);

    assert.equal(w.emit("cron.run.ok", { title: "c" }), 0, "filter excludes cron events");
    assert.equal(w.emit("session.failed", { title: "S", text: "t" }, "evt_A"), 1);
    assert.equal(w.emit("session.failed", { title: "S", text: "t" }, "evt_A"), 1);
    assert.equal(store.deliveries(sub.id).length, 1, "the same event id is queued once");

    await w.flush();
    assert.equal(seen.length, 1);
    const h = seen[0]!.headers;
    assert.equal(h["X-Luna-Event"], "session.failed");
    assert.equal(h["X-Luna-Delivery"], "evt_A");
    assert.equal(h["X-Luna-Signature"], `sha256=${sign(secret, seen[0]!.body)}`);
    let d = store.deliveries(sub.id)[0]!;
    assert.deepEqual([d.status, d.attempts, d.responseStatus, d.nextAt], ["pending", 1, 500, clock + RETRY_DELAYS_MS[0]!]);

    // Not due yet: nothing is sent.
    await w.flush();
    assert.equal(seen.length, 1);

    // Restart: a new store and dispatcher on the same file pick the pending delivery up.
    await w.close();
    store.close();
    store = new WebhookStore(path);
    w = new Webhooks(store, { targets: () => undefined, fetch: fetchFake, clock: () => clock });
    for (const delay of RETRY_DELAYS_MS) { clock += delay; await w.flush(); }
    d = store.deliveries(sub.id)[0]!;
    assert.deepEqual([d.status, d.attempts], ["failed", RETRY_DELAYS_MS.length + 1]);
    assert.equal(seen.length, RETRY_DELAYS_MS.length + 1);

    // Redeliver after the endpoint is fixed.
    reply = 200;
    store.redeliver(d.id, clock);
    await w.flush();
    d = store.getDelivery(d.id)!;
    assert.deepEqual([d.status, d.attempts, d.responseStatus], ["ok", 1, 200]);

    // 410 Gone ends the delivery at once.
    reply = 410;
    w.emit("session.finished", { title: "S" }, "evt_B");
    await w.flush();
    assert.equal(store.deliveries(sub.id)[0]!.status, "failed");

    // Test events ignore the filter; a disabled subscription receives nothing.
    reply = 204;
    const t = w.test(sub.id);
    await w.flush();
    assert.equal(store.getDelivery(t.id)!.status, "ok");
    store.updateSub(sub.id, { enabled: false });
    assert.equal(w.emit("session.finished", { title: "S" }), 0);
    await w.close();
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("daemon: /hooks/<slug> bypasses bearer auth, creates a session, and admin routes need the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-webhooks-rt-"));
  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage([fauxText("got the hook")])]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const modelRef = { provider: model.provider, modelId: model.id };
  const rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["webhooks"] }), { models, model: modelRef });
  try {
    const token = "daemon-token";
    const app = createApp({ harness: rt.harness, conversations: rt.conversations, models, agent: { model: modelRef }, webhooks: rt.webhooks, token });
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    assert.equal((await app.request("/v1/webhooks/inbound")).status, 401);
    const bad = await app.request("/v1/webhooks/inbound", { method: "POST", headers: auth, body: JSON.stringify({ name: "x", target: { kind: "project", id: 42 } }) });
    assert.equal(bad.status, 400);
    const created = await app.request("/v1/webhooks/inbound", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Deploys", target: { kind: "project", id: 0 }, template: "deploy {{body.status}}" }) });
    assert.equal(created.status, 201);
    const hook = await created.json() as { id: number; path: string; secret: string };
    assert.match(hook.path, /^\/hooks\//);
    const listed = await (await app.request("/v1/webhooks/inbound", { headers: auth })).json() as unknown[];
    assert.equal(JSON.stringify(listed).includes(hook.secret), false);

    const body = JSON.stringify({ status: "green" });
    const unsigned = await app.request(hook.path, { method: "POST", body });
    assert.equal(unsigned.status, 401);
    const res = await app.request(hook.path, { method: "POST", body, headers: { "x-signature": `sha256=${sign(hook.secret, body)}`, "x-request-id": "r1" } });
    assert.equal(res.status, 202);
    const { sessionId } = await res.json() as { sessionId: number };
    assert.ok(sessionId > 0);
    assert.equal(rt.conversations.get(sessionId).title, "Deploys");

    const big = "x".repeat(1024 * 1024 + 10);
    assert.equal((await app.request(hook.path, { method: "POST", body: big, headers: { "content-length": String(big.length) } })).status, 413);

    const log = await (await app.request(`/v1/webhooks/inbound/${hook.id}/log`, { headers: auth })).json() as { outcome: string; sessionId: number | null }[];
    assert.deepEqual(log.map(l => l.outcome), ["delivered", "rejected"]);
    assert.equal(log[0]!.sessionId, sessionId);

    const sub = await app.request("/v1/webhooks/outbound", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "ntfy", url: "https://ntfy.example/luna", format: "ntfy", events: ["session.*"] }) });
    assert.equal(sub.status, 201);
    assert.equal((await app.request("/v1/webhooks/inbound/abc", { method: "DELETE", headers: auth })).status, 404);
    assert.equal((await app.request(`/v1/webhooks/inbound/${hook.id}`, { method: "DELETE", headers: auth })).status, 200);
    assert.equal((await app.request(hook.path, { method: "POST", body })).status, 404);
  } finally {
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
