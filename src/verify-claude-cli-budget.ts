// Offline regression through the real pi provider. Only the external transport is replaced.
import assert from "node:assert/strict";
import { mock } from "node:test";
import { createModels, type Context, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import * as native from "./claude-native.js";

let calls = 0;
let lastRequest: native.NativeRequest | undefined;
let next: native.NativeResponse | undefined;
let finalReady = false;
const tool = { name: "lookup", description: "Read a value", parameters: { type: "object", properties: {} } };
const toolCall = (id: string, name = "lookup", args = '{}'): native.NativeToolCall => ({
  id, type: "function", function: { name, arguments: args },
});
const completion = (model: string, content: string | null = "ok", tool_calls: native.NativeToolCall[] | null = null,
  finish_reason = tool_calls?.length ? "tool_calls" : "stop"): native.NativeResponse => ({
  id: "msg-fixture", model, choices: [{ finish_reason, message: { content, tool_calls } }],
  usage: { native_usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 13, cache_creation_input_tokens: 17 } },
});
mock.module(new URL("./claude-native.js", import.meta.url).href, { namedExports: {
  ...native,
  runNativeRequest: async (request: native.NativeRequest, options: Parameters<typeof native.runNativeRequest>[1]) => {
    calls++;
    lastRequest = request;
    const response = next ?? completion(request.model);
    if (response.choices[0]?.message.content) options.onText(response.choices[0].message.content);
    finalReady = true;
    return response;
  },
} });
let discoveryPrompt: unknown;
let discoveryClosed = false;
let discoveryThrows = false;
mock.module("@anthropic-ai/claude-agent-sdk", { namedExports: {
  query: ({ prompt }: { prompt: unknown }) => {
    discoveryPrompt = prompt;
    if (discoveryThrows) throw new Error("fixture synchronous discovery failure");
    return { supportedModels: async () => [
      { value: "new", resolvedModel: "claude-new-test", displayName: "New" },
      { value: "new1m", resolvedModel: "claude-new-test[1m]", displayName: "New 1M" },
    ], close: () => { discoveryClosed = true; } };
  },
} });
const { claudeCliProvider } = await import("./claude-cli.js");
const models = createModels();
models.setProvider(claudeCliProvider());
const model = models.getModels("claude-cli")[0]!;
const user = (content = "Keep the exact latest request."): Context => ({ messages: [{ role: "user", content, timestamp: 1 }] });
const generate = async (context: Context) => {
  finalReady = false;
  const events: AssistantMessageEvent[] = [];
  const stream = models.streamSimple(model, context);
  for await (const event of stream) {
    if (event.type === "toolcall_end") assert.equal(finalReady, true, "no tool may become actionable before a completed response");
    events.push(event);
  }
  return { result: await stream.result(), events };
};
try {
  // No size guard: a large history reaches the transport; compaction belongs to the runtime.
  const large = await generate(user("x".repeat(1_300_000)));
  assert.equal(large.result.stopReason, "stop", large.result.errorMessage ?? "large request failed");
  assert.equal(calls, 1);

  const small = await generate(user());
  assert.equal(small.result.stopReason, "stop", small.result.errorMessage ?? "small request failed");
  assert.equal(calls, 2);
  assert.deepEqual(lastRequest!.messages, [{ role: "user", content: "Keep the exact latest request." }]);
  assert.deepEqual(small.result.usage, { input: 11, output: 7, cacheRead: 13, cacheWrite: 17, totalTokens: 48,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  console.log("OK: large and small requests reach the transport with exact usage");

  const context: Context = { ...user("Look up the actual value."), tools: [tool] };
  next = completion(model.id, null, [toolCall("call-1"), toolCall("call-2")]);
  const first = await generate(context);
  assert.equal(first.result.stopReason, "toolUse", first.result.errorMessage ?? "tool batch failed");
  assert.equal(first.events.filter(e => e.type === "toolcall_end").length, 2);
  assert.ok(first.result.content.some(b => b.type === "text" && b.textSignature?.startsWith("luna-claude-native-v1:")));
  context.messages.push(first.result,
    { role: "toolResult", toolCallId: "call-1", toolName: "lookup", isError: false,
      content: [{ type: "text", text: "real-host-result-91827" }], timestamp: 2 },
    { role: "toolResult", toolCallId: "call-2", toolName: "lookup", isError: true,
      content: [{ type: "text", text: "actual host failure" }], timestamp: 3 });
  next = undefined;
  assert.equal((await generate(context)).result.stopReason, "stop");
  assert.deepEqual(lastRequest!.messages.slice(-2), [
    { role: "tool", tool_call_id: "call-1", is_error: false, content: [{ type: "text", text: "real-host-result-91827" }] },
    { role: "tool", tool_call_id: "call-2", is_error: true, content: [{ type: "text", text: "actual host failure" }] },
  ]);
  assert.doesNotMatch(JSON.stringify(lastRequest), /timestamp|totalTokens|stopReason|permission-denied/);
  console.log("OK: native tool batches return to Luna; subsequent generation receives the real host results");

  for (const bad of [toolCall("bad", "unknown"), toolCall("bad", "lookup", "not-json"),
    toolCall("bad", "lookup", "[]"), toolCall("same")]) {
    next = completion(model.id, "before tools", [toolCall("same"), bad]);
    const rejected = await generate({ ...user(), tools: [tool] });
    assert.equal(rejected.result.stopReason, "error", JSON.stringify(bad));
    assert.equal(rejected.result.usage.totalTokens, 48, "a rejected tool batch still consumed the completed upstream usage");
    assert.equal(rejected.events.filter(e => e.type === "toolcall_end").length, 0);
    assert.equal(rejected.result.content.filter(b => b.type === "toolCall").length, 0);
  }
  next = completion(model.id); next.usage = {} as native.NativeResponse["usage"];
  assert.equal((await generate(user())).result.stopReason, "error");
  next = completion(model.id, "cut short", [toolCall("cut")], "length");
  const length = await generate({ ...user(), tools: [tool] });
  assert.equal(length.result.stopReason, "length");
  assert.equal(length.events.filter(e => e.type === "toolcall_end").length, 0);
  next = completion(model.id, null, [toolCall("refused")], "content_filter");
  next.choices[0]!.message.refusal = "Request refused";
  const refused = await generate({ ...user(), tools: [tool] });
  assert.equal(refused.result.stopReason, "error");
  assert.match(refused.result.errorMessage!, /Request refused/);
  assert.equal(refused.events.filter(e => e.type === "toolcall_end").length, 0);
  console.log("OK: invalid or incomplete batches and refusals never expose actionable tools");

  assert.ok(models.getModels("claude-cli").every(m => m.contextWindow === 200000));
  const refreshed = await models.refresh({ providers: ["claude-cli"], allowNetwork: true });
  assert.equal(refreshed.errors.size, 0);
  assert.equal(models.getModel("claude-cli", "claude-new-test")!.contextWindow, 200000);
  assert.equal(models.getModel("claude-cli", "claude-new-test[1m]")!.contextWindow, 1000000);
  assert.equal(typeof discoveryPrompt, "object", "discovery must not send a user prompt string");
  assert.ok(discoveryPrompt && Symbol.asyncIterator in Object(discoveryPrompt));
  const frames = [];
  for await (const frame of discoveryPrompt as AsyncIterable<unknown>) frames.push(frame);
  assert.deepEqual(frames, []);
  assert.equal(discoveryClosed, true);
  console.log("OK: catalog windows stay conservative; model discovery sends no user frames");

  // A synchronous SDK startup failure must also clear the discovery timeout.
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    const timer = originalSet(callback, delay, ...args);
    if (delay === 15000) pending.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
    pending.delete(timer as ReturnType<typeof setTimeout>);
    originalClear(timer);
  }) as typeof clearTimeout;
  discoveryThrows = true;
  try {
    const failed = await models.refresh({ providers: ["claude-cli"], allowNetwork: true });
    assert.equal(failed.errors.size, 1);
    assert.equal(pending.size, 0, "discovery startup failure must not leak its timeout");
  } finally {
    for (const timer of pending) originalClear(timer);
    globalThis.setTimeout = originalSet;
    globalThis.clearTimeout = originalClear;
  }
  console.log("OK: failed discovery also clears its timeout");
  console.log("CLAUDE_CLI_BUDGET_OK");
} finally {
  mock.restoreAll();
}
