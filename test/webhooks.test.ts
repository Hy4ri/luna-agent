import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import {
  DEDUPE_KEEP_MS, formatRequest, matches, render, RETRY_DELAYS_MS, sign, verifyRequest, WebhookStore, Webhooks,
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
  expect(verifyRequest("hmac", "s3cret", body, hdr({ "x-hub-signature-256": good }), noQuery)).toBe(true);
  expect(verifyRequest("hmac", "s3cret", body, hdr({ "x-signature": sign("s3cret", body).toUpperCase() }), noQuery)).toBe(true);
  expect(verifyRequest("hmac", "other", body, hdr({ "x-hub-signature-256": good }), noQuery)).toBe(false);
  expect(verifyRequest("hmac", "s3cret", enc('{"a":2}'), hdr({ "x-hub-signature-256": good }), noQuery)).toBe(false);
  expect(verifyRequest("hmac", "s3cret", body, hdr({}), noQuery)).toBe(false);
  expect(verifyRequest("hmac", "s3cret", body, hdr({ "x-hub-signature-256": "sha256=abc" }), noQuery)).toBe(false);
  expect(verifyRequest("token", "tok", body, hdr({ authorization: "Bearer tok" }), noQuery)).toBe(true);
  expect(verifyRequest("token", "tok", body, hdr({ "x-gitlab-token": "tok" }), noQuery)).toBe(true);
  expect(verifyRequest("token", "tok", body, hdr({}), k => (k === "token" ? "tok" : undefined))).toBe(true);
  expect(verifyRequest("token", "tok", body, hdr({ authorization: "Bearer nope" }), noQuery)).toBe(false);
  // A token hook never accepts a signature, and the reverse.
  expect(verifyRequest("token", "tok", body, hdr({ "x-hub-signature-256": `sha256=${sign("tok", body)}` }), noQuery)).toBe(false);
});

test("matches, render and formatRequest", () => {
  expect(matches([], "push")).toBe(true);
  expect(matches(["push"], "push")).toBe(true);
  expect(matches(["pull_request.opened"], "pull_request", "opened")).toBe(true);
  expect(matches(["pull_request.opened"], "pull_request", "closed")).toBe(false);
  expect(matches(["session.*"], "session.failed")).toBe(true);
  expect(matches(["cron.*"], "session.failed")).toBe(false);
  expect(matches(["*"], null)).toBe(true);
  expect(matches(["push"], null)).toBe(false);

  const out = render("{{event}}/{{action}}: {{body.pull_request.title}} by {{ body.user.login }} {{headers.x-github-event}} {{body.missing}}|{{body.n}}", {
    body: { pull_request: { title: "Fix" }, user: { login: "m57" }, n: 0 }, headers: { "x-github-event": "pull_request" },
    event: "pull_request", action: "opened", delivery: "d1", hook: "gh", payload: "{}",
  });
  expect(out).toBe("pull_request/opened: Fix by m57 pull_request |0");

  const env = { id: "evt_1", event: "session.failed", createdAt: "2026-01-01T00:00:00.000Z", data: { title: "Sessión 3", text: "boom" } };
  expect(JSON.parse(formatRequest("json", env).body)).toEqual(env);
  const ntfy = formatRequest("ntfy", env);
  expect(ntfy.body).toBe("boom");
  expect(ntfy.headers.Title!).toMatch(/^=\?UTF-8\?B\?/);
  expect(JSON.parse(formatRequest("discord", env).body).content).toBe("**Sessión 3**\nboom");
  expect(JSON.parse(formatRequest("slack", env).body).text).toBe("*Sessión 3*\nboom");
});

test("inbound: signature, filter, dedupe, rate limit, targets and log", async () => {
  const store = new WebhookStore(":memory:");
  const { t, calls } = fakeTargets();
  let clock = 1_000_000;
  const w = new Webhooks(store, { targets: () => t, clock: () => clock });
  const { hook, secret } = store.createInbound({ name: "GitHub", target: { kind: "project", id: 0 }, events: ["pull_request.opened", "issues"],
    template: "PR {{body.number}}: {{body.title}}" });
  expect(secret).toMatch(/^whsec_/);
  expect(JSON.stringify(store.listInbound()).includes(secret)).toBe(false) /* "list never shows the secret" */;

  const send = (body: string, h: Record<string, string> = {}, s = secret) =>
    w.receive(hook.slug, enc(body), hdr({ "x-hub-signature-256": `sha256=${sign(s, enc(body))}`, ...h }), noQuery);

  expect((await w.receive("nope", enc("{}"), hdr({}), noQuery)).status).toBe(404);
  expect((await send('{"action":"opened"}', { "x-github-event": "pull_request" }, "wrong")).status).toBe(401);
  expect((await send("{}", { "x-github-event": "ping" })).status).toBe(200);

  const ok = await send('{"action":"opened","number":7,"title":"Add hooks"}', { "x-github-event": "pull_request", "x-github-delivery": "D1" });
  expect(ok.status).toBe(202);
  expect(ok.body.sessionId).toBe(77);
  expect(calls.length).toBe(1);
  expect(calls[0]!.title).toBe("GitHub: pull_request.opened");
  expect(calls[0]!.content!).toMatch(/untrusted data/);
  expect(calls[0]!.content!).toMatch(/PR 7: Add hooks/);
  expect(calls[0]!.requestId).toBe(`webhook:${hook.id}:D1`);

  const dup = await send('{"action":"opened","number":7,"title":"Add hooks"}', { "x-github-event": "pull_request", "x-github-delivery": "D1" });
  expect([dup.status, dup.body.duplicate, dup.body.sessionId]).toEqual([200, true, 77]);
  expect(calls.length).toBe(1) /* "a redelivered id does not run twice" */;

  const ign = await send('{"action":"closed"}', { "x-github-event": "pull_request", "x-github-delivery": "D2" });
  expect([ign.status, ign.body.ignored]).toEqual([202, true]);
  expect(calls.length).toBe(1);

  // A rejected delivery id can still succeed later (the sender retries after a secret fix).
  expect((await send('{"x":1}', { "x-github-event": "issues", "x-github-delivery": "D3" }, "wrong")).status).toBe(401);
  expect((await send('{"x":1}', { "x-github-event": "issues", "x-github-delivery": "D3" })).status).toBe(202);

  const log = store.inboundLog(hook.id);
  expect(log.map(l => l.outcome)).toEqual(["delivered", "rejected", "ignored", "duplicate", "delivered", "rejected"]);
  expect(store.getInbound(hook.id)!.received).toBe(2);

  // Rate limit: 60 per minute per hook.
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await send('{"n":1}', { "x-github-event": "issues" })).status === 429) limited++;
  expect(limited >= 10).toBeTruthy() /* `limited ${limited}` */;
  clock += 61_000;
  expect((await send('{"n":1}', { "x-github-event": "issues" })).status).toBe(202);

  // Session target that vanished: 410. Cron target: run id.
  const gone = store.createInbound({ name: "gone", target: { kind: "session", id: 404 }, verify: "token" });
  expect((await w.receive(gone.hook.slug, enc("hi"), hdr({ authorization: `Bearer ${gone.secret}` }), noQuery)).status).toBe(410);
  const cron = store.createInbound({ name: "cron", target: { kind: "cron", id: 3 }, verify: "token" });
  const r = await w.receive(cron.hook.slug, enc("go"), hdr({ "x-webhook-token": cron.secret }), noQuery);
  expect([r.status, r.body.runId]).toEqual([202, 5]);

  // Disabled and rotated hooks.
  store.updateInbound(cron.hook.id, { enabled: false });
  expect((await w.receive(cron.hook.slug, enc("go"), hdr({ "x-webhook-token": cron.secret }), noQuery)).status).toBe(404);
  const fresh = store.rotateInbound(gone.hook.id);
  expect(fresh).not.toBe(gone.secret);
  expect((await w.receive(gone.hook.slug, enc("hi"), hdr({ authorization: `Bearer ${gone.secret}` }), noQuery)).status).toBe(401);

  await expect(w.checkTarget({ kind: "session", id: 999 })).rejects.toThrow(/no such session 999/);
  await expect(w.checkTarget({ kind: "bogus", id: 1 })).rejects.toThrow(/target must be/);
  await w.close();
  store.close();
});

test("inbound dedupe: concurrent same id dispatches once, survives log trimming, and frees the id after a failure", async () => {
  const store = new WebhookStore(":memory:");
  let clock = 2_000_000;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let created = 0, fail = false;
  const t: WebhookTargets = {
    async toSession() { return true; },
    async newSession() { await gate; if (fail) throw new Error("boom"); return ++created; },
    async runCron() { return 1; },
    async exists() { return true; },
  };
  const w = new Webhooks(store, { targets: () => t, clock: () => clock });
  const { hook, secret } = store.createInbound({ name: "h", target: { kind: "project", id: 0 }, verify: "token" });
  const send = (id: string) => w.receive(hook.slug, enc("{}"), hdr({ "x-webhook-token": secret, "x-luna-delivery": id }), noQuery);

  // Two requests with one delivery id race: the second sees the claim and does not dispatch.
  const a = send("R1"), b = send("R1");
  release();
  const [ra, rb] = await Promise.all([a, b]);
  expect([ra.status, rb.status].sort()).toEqual([202, 409]);
  expect(created).toBe(1) /* "one session for one delivery id" */;
  expect([(await send("R1")).status, (await send("R1")).body.sessionId]).toEqual([200, 1]);

  // More than 100 log entries (duplicates included) do not evict the dedupe record.
  for (let i = 0; i < 120; i++) { clock += 2_000; expect((await send("R1")).status).toBe(200); }
  expect(store.inboundLog(hook.id, 500).length).toBe(100);
  expect((await send("R1")).status).toBe(200);
  expect(created).toBe(1);

  // A failed dispatch frees the id, so the sender's retry runs.
  clock += 61_000;
  fail = true;
  expect((await send("R2")).status).toBe(500);
  fail = false;
  expect((await send("R2")).status).toBe(202);
  expect((await send("R2")).status).toBe(200);

  // A claim left by a crashed dispatch is taken over after 10 minutes.
  expect(store.reserve(hook.id, "R3", clock)).toEqual({ state: "new" });
  expect(store.reserve(hook.id, "R3", clock + 1_000)).toEqual({ state: "busy" });
  expect(store.reserve(hook.id, "R3", clock + 11 * 60_000)).toEqual({ state: "new" });

  // Dedupe ids expire after 30 days through prune.
  store.prune(clock + DEDUPE_KEEP_MS + 120 * 60_000);
  expect(store.reserve(hook.id, "R1", clock)).toEqual({ state: "new" });
  await w.close();
  store.close();
});

test("outbound: the running dispatcher prunes old finished deliveries, not only at start", async () => {
  const store = new WebhookStore(":memory:");
  let clock = 9_000_000;
  const fetchFake = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
  const w = new Webhooks(store, { targets: () => undefined, fetch: fetchFake, clock: () => clock });
  const { sub } = store.createSub({ name: "s", url: "https://example.test/h", events: [] });
  w.start();
  w.emit("session.finished", { title: "S" }, "evt_old");
  await w.flush();
  expect(store.deliveries(sub.id).length).toBe(1);
  clock += 8 * 24 * 3_600_000;
  w.emit("session.finished", { title: "S" }, "evt_new");
  await w.flush();
  expect(store.deliveries(sub.id).map(d => d.eventId)).toEqual(["evt_new"]);
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
    expect(() => store.createSub({ name: "x", url: "ftp://x", events: [] })).toThrow(/http\(s\) URL/);
    expect(() => store.createSub({ name: "x", url: "https://x", events: ["nope.event"] })).toThrow(/unknown event/);

    expect(w.emit("cron.run.ok", { title: "c" })).toBe(0) /* "filter excludes cron events" */;
    expect(w.emit("session.failed", { title: "S", text: "t" }, "evt_A")).toBe(1);
    expect(w.emit("session.failed", { title: "S", text: "t" }, "evt_A")).toBe(1);
    expect(store.deliveries(sub.id).length).toBe(1) /* "the same event id is queued once" */;

    await w.flush();
    expect(seen.length).toBe(1);
    const h = seen[0]!.headers;
    expect(h["X-Luna-Event"]).toBe("session.failed");
    expect(h["X-Luna-Delivery"]).toBe("evt_A");
    expect(h["X-Luna-Signature"]).toBe(`sha256=${sign(secret, seen[0]!.body)}`);
    let d = store.deliveries(sub.id)[0]!;
    expect([d.status, d.attempts, d.responseStatus, d.nextAt]).toEqual(["pending", 1, 500, clock + RETRY_DELAYS_MS[0]!]);

    // Not due yet: nothing is sent.
    await w.flush();
    expect(seen.length).toBe(1);

    // Restart: a new store and dispatcher on the same file pick the pending delivery up.
    await w.close();
    store.close();
    store = new WebhookStore(path);
    w = new Webhooks(store, { targets: () => undefined, fetch: fetchFake, clock: () => clock });
    for (const delay of RETRY_DELAYS_MS) { clock += delay; await w.flush(); }
    d = store.deliveries(sub.id)[0]!;
    expect([d.status, d.attempts]).toEqual(["failed", RETRY_DELAYS_MS.length + 1]);
    expect(seen.length).toBe(RETRY_DELAYS_MS.length + 1);

    // Redeliver after the endpoint is fixed.
    reply = 200;
    store.redeliver(d.id, clock);
    await w.flush();
    d = store.getDelivery(d.id)!;
    expect([d.status, d.attempts, d.responseStatus]).toEqual(["ok", 1, 200]);

    // 410 Gone ends the delivery at once.
    reply = 410;
    w.emit("session.finished", { title: "S" }, "evt_B");
    await w.flush();
    expect(store.deliveries(sub.id)[0]!.status).toBe("failed");

    // Test events ignore the filter; a disabled subscription receives nothing.
    reply = 204;
    const t = w.test(sub.id);
    await w.flush();
    expect(store.getDelivery(t.id)!.status).toBe("ok");
    store.updateSub(sub.id, { enabled: false });
    expect(w.emit("session.finished", { title: "S" })).toBe(0);
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

    expect((await app.request("/v1/webhooks/inbound")).status).toBe(401);
    const bad = await app.request("/v1/webhooks/inbound", { method: "POST", headers: auth, body: JSON.stringify({ name: "x", target: { kind: "project", id: 42 } }) });
    expect(bad.status).toBe(400);
    const created = await app.request("/v1/webhooks/inbound", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "Deploys", target: { kind: "project", id: 0 }, template: "deploy {{body.status}}" }) });
    expect(created.status).toBe(201);
    const hook = await created.json() as { id: number; path: string; secret: string };
    expect(hook.path).toMatch(/^\/hooks\//);
    const listed = await (await app.request("/v1/webhooks/inbound", { headers: auth })).json() as unknown[];
    expect(JSON.stringify(listed).includes(hook.secret)).toBe(false);

    const body = JSON.stringify({ status: "green" });
    const unsigned = await app.request(hook.path, { method: "POST", body });
    expect(unsigned.status).toBe(401);
    const res = await app.request(hook.path, { method: "POST", body, headers: { "x-signature": `sha256=${sign(hook.secret, body)}`, "x-request-id": "r1" } });
    expect(res.status).toBe(202);
    const { sessionId } = await res.json() as { sessionId: number };
    expect(sessionId > 0).toBeTruthy();
    expect(rt.conversations.get(sessionId).title).toBe("Deploys");

    const big = "x".repeat(1024 * 1024 + 10);
    expect((await app.request(hook.path, { method: "POST", body: big, headers: { "content-length": String(big.length) } })).status).toBe(413);

    const log = await (await app.request(`/v1/webhooks/inbound/${hook.id}/log`, { headers: auth })).json() as { outcome: string; sessionId: number | null }[];
    expect(log.map(l => l.outcome)).toEqual(["delivered", "rejected"]);
    expect(log[0]!.sessionId).toBe(sessionId);

    const sub = await app.request("/v1/webhooks/outbound", { method: "POST", headers: auth,
      body: JSON.stringify({ name: "ntfy", url: "https://ntfy.example/luna", format: "ntfy", events: ["session.*"] }) });
    expect(sub.status).toBe(201);
    expect((await app.request("/v1/webhooks/inbound/abc", { method: "DELETE", headers: auth })).status).toBe(404);
    expect((await app.request(`/v1/webhooks/inbound/${hook.id}`, { method: "DELETE", headers: auth })).status).toBe(200);
    expect((await app.request(hook.path, { method: "POST", body })).status).toBe(404);
  } finally {
    await rt.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
