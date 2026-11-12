// Contract: on models with mid-conversation effort, a level change moves only the per-message effort markers.
// The top-level request (thinking, output_config, tools) stays byte-stable, so the cached prefix survives.
import assert from "node:assert/strict";
import { test } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { claudeCliProvider } from "../src/claude-cli.js";
import { prepareNativeRequest } from "../src/claude-native.js";
import { Admission } from "../src/claude-native/admission.js";
import { buildBody } from "../src/claude-native/history.js";

const models = claudeCliProvider().getModels();
const opus = models.find(m => m.id === "claude-opus-5-5")!;
const sonnet46 = models.find(m => m.id === "claude-sonnet-4-6");

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (text: string, providerThinkingLevel?: string, provider = "claude-cli") => ({
  role: "assistant", content: [{ type: "text", text }], api: "anthropic-messages", provider, model: "claude-opus-5-5",
  usage, stopReason: "stop", timestamp: 1, ...(providerThinkingLevel ? { providerThinkingLevel } : {}),
});
const context = { messages: [
  { role: "system", content: "policy", timestamp: 1 },
  { role: "user", content: "one", timestamp: 1 },
  assistant("a1", "medium"),
  { role: "user", content: "two", timestamp: 1 },
  assistant("a2", "high", "zenmux"),
  { role: "user", content: "three", timestamp: 1 },
] } as unknown as TranscriptContext;

test("claude-cli copies the mid-conversation effort capability", () => {
  assert.equal(opus.compat?.supportsMidConvoEffort, true);
});

test("effort markers replay each reply's level and keep the top-level request fixed", () => {
  const high = prepareNativeRequest(context, opus, undefined, "high");
  assert.deepEqual(high.thinking, { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  assert.deepEqual(high.output_config, { effort: "low" });
  assert.equal(high.providerThinkingLevel, "high");
  assert.deepEqual(high.replayMetadata?.systemInjections, [
    { beforeAssistant: 0, content: [], output_config: { effort: "medium" } },
    { beforeAssistant: null, content: [], output_config: { effort: "high" } },
  ], "foreign-provider replies carry no marker");
  assert.ok(high.replayMetadata?.betas?.includes("mid-conversation-output-config-2026-07-01"));
  assert.ok(high.replayMetadata?.betas?.includes("thinking-binding-controls-2026-08-01"));

  const max = prepareNativeRequest(context, opus, undefined, "max");
  assert.equal(max.providerThinkingLevel, "max");
  assert.equal(buildBody(max).body, buildBody(high).body, "a level change keeps the extra body byte-identical");
  assert.deepEqual(max.replayMetadata?.systemInjections?.at(-1)?.output_config, { effort: "max" });
});

test("thinking off sends no effort markers", () => {
  const off = prepareNativeRequest(context, opus, undefined, undefined);
  if (opus.thinkingLevelMap?.off !== null) assert.equal(off.thinking?.type, "disabled");
  assert.equal(off.output_config, undefined);
  assert.equal(off.replayMetadata, undefined);
});

test("models without mid-conversation effort keep the top-level effort", () => {
  if (!sonnet46?.compat?.forceAdaptiveThinking || sonnet46.compat.supportsMidConvoEffort) return;
  const request = prepareNativeRequest(context, sonnet46, undefined, "high");
  assert.deepEqual(request.output_config, { effort: "high" });
  assert.equal(request.replayMetadata, undefined);
});

test("admission places effort markers before each reply and adds the betas", async () => {
  const seen: { body?: any; headers?: Headers } = {};
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      seen.body = await req.json();
      seen.headers = req.headers;
      return new Response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const request = prepareNativeRequest(context, opus, undefined, "high");
  const gate = await Admission.open(`http://127.0.0.1:${server.port}`, 3000,
    undefined, request.replayMetadata);
  try {
    const response = await fetch(gate.url + "/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "anthropic-beta": "claude-code-20250219" },
      body: JSON.stringify({ messages: [
        { role: "user", content: [{ type: "text", text: "one" }] },
        { role: "assistant", content: [{ type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: "two" }] },
        { role: "assistant", content: [{ type: "text", text: "a2" }] },
        { role: "user", content: [{ type: "text", text: "three" }] },
      ] }) });
    await response.text();
    const roles = seen.body.messages.map((m: { role: string; output_config?: { effort: string } }) =>
      m.output_config ? `system:${m.output_config.effort}` : m.role);
    assert.deepEqual(roles, ["user", "system:medium", "assistant", "user", "assistant", "user", "system:high"]);
    const lastUser = seen.body.messages.at(-2).content.at(-1);
    assert.deepEqual(lastUser.cache_control, { type: "ephemeral", ttl: "1h" }, "the newest turn keeps its cache breakpoint");
    assert.deepEqual(seen.body.messages.at(-1).content, []);
    const betas = String(seen.headers!.get("anthropic-beta")).split(",");
    for (const beta of ["claude-code-20250219", "mid-conversation-output-config-2026-07-01", "thinking-binding-controls-2026-08-01"]) {
      assert.ok(betas.includes(beta), beta);
    }
  } finally {
    await gate.close();
    server.stop(true);
  }
});
