// HTTP/SSE contract for independent runs, durable admission, and observer-only client connections.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
const dir = mkdtempSync(join(tmpdir(), "luna-sync-"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, provider: "faux" }, dir, {}), { models, model });
const app = createApp({ harness: rt.harness, models, conversations: rt.conversations, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const headers = { authorization: "Bearer test", "content-type": "application/json" };
const request = (path: string, opts: RequestInit = {}) => fetch(url + path, { ...opts, headers: { ...headers, ...opts.headers } });
const post = (path: string, body = {}) => request(path, { method: "POST", body: JSON.stringify(body) });
const controllers: AbortController[] = [];
function deadline<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("deadline exceeded")), ms); promise.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); }); });
}
async function feed(path: string) {
  const controller = new AbortController(); controllers.push(controller);
  const res = await request(path, { signal: controller.signal }); assert.equal(res.status, 200);
  const reader = res.body!.getReader(), decoder = new TextDecoder(); let buf = "";
  return { close: () => controller.abort(), async next(type: string): Promise<any> {
    for (;;) {
      const boundary = buf.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buf.slice(0, boundary); buf = buf.slice(boundary + 2);
        if (frame.match(/^event: (.*)$/m)?.[1] === type) return JSON.parse(frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("\n"));
      } else { const chunk = await reader.read(); if (chunk.done) throw new Error("feed ended"); buf += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n"); }
    }
  } };
}
let release!: () => void;
try {
  assert.equal((await fetch(url + "/v1/events")).status, 401);
  const global = await feed("/v1/events"); await deadline(global.next("sessions_changed"));
  const id = (await (await post("/v1/sessions")).json() as any).id;
  await deadline(global.next("sessions_changed"));
  const observer = await feed(`/v1/sessions/${id}/events`); const initial = await deadline(observer.next("snapshot"));
  assert.equal(initial.run, undefined);
  let entered!: () => void; const started = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
  faux.setResponses([async () => { entered(); await gate; return fauxAssistantMessage("first completed"); }]);
  const accepted = await deadline(post(`/v1/sessions/${id}/messages?async=1`, { content: "first", requestId: "once" }), 1000);
  assert.equal(accepted.status, 202); const receipt = await accepted.json() as any; assert.ok(receipt.submissionId);
  await deadline(started);
  const duplicate = await post(`/v1/sessions/${id}/messages?async=1`, { content: "first", requestId: "once" });
  assert.equal(duplicate.status, 202); assert.equal((await duplicate.json() as any).submissionId, receipt.submissionId);
  const listed = await (await request("/v1/sessions")).json() as any;
  assert.equal(listed.sessions.find((s: any) => s.id === id).running, true);
  const attached = await feed(`/v1/sessions/${id}/events`); const running = await deadline(attached.next("snapshot"));
  assert.ok(running.run || running.generation);
  assert.ok(running.entries.some((e: any) => e.kind === "pi.user"));
  // Disconnecting both viewers must not stop the server's accepted input.
  observer.close(); attached.close();
  const second = (await (await post("/v1/sessions")).json() as any).id;
  faux.appendResponses([fauxAssistantMessage("second completed")]);
  const acceptedSecond = await post(`/v1/sessions/${second}/messages?async=1`, { content: "second", requestId: "two" });
  assert.equal(acceptedSecond.status, 202);
  const secondConv = (await rt.harness.conversation(second, context))!; await deadline(secondConv.waitForIdle(context));
  const stillRunning = await (await request("/v1/sessions")).json() as any;
  assert.equal(stillRunning.sessions.find((s: any) => s.id === id).running, true);
  assert.equal(stillRunning.sessions.find((s: any) => s.id === second).running, false);
  release(); await deadline(rt.harness.waitForIdle(context));
  const resumed = await feed(`/v1/sessions/${id}/events`); const final = await deadline(resumed.next("snapshot"));
  assert.equal(final.run, undefined);
  assert.equal(final.entries.filter((e: any) => e.kind === "pi.user").length, 1);
  assert.ok(JSON.stringify(final.entries).includes("first completed"));
  assert.ok(!JSON.stringify(final.entries).includes("second completed"));
  // Observe metadata from a different client without submitting a turn.
  await request(`/v1/sessions/${id}/metadata`, { method: "PATCH", body: JSON.stringify({ title: "renamed elsewhere", pinned: true }) });
  await deadline(global.next("sessions_changed"));
  const after = await (await request("/v1/sessions")).json() as any;
  assert.equal(after.sessions.find((s: any) => s.id === id).title, "renamed elsewhere");
  await request(`/v1/sessions/${id}`, { method: "DELETE" });
  await deadline(global.next("sessions_changed"));
  assert.equal((await request(`/v1/sessions/${id}`)).status, 404);
  assert.equal((await post(`/v1/sessions/${second}/messages?async=1`, { content: "" })).status, 400);
  console.log("CONVERSATION_SYNC_OK: async durable admission, idempotency, independent runs, observer detach/rejoin, shared list notifications");
} finally {
  release?.(); for (const c of controllers) c.abort();
  if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
