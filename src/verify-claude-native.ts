// Offline converter tests. Process transport tests live in verify-claude-transport.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { prepareNativeRequest as convertNative, nativeResponseCarrier, type NativeResponse } from "./claude-native.js";
const prepareNativeRequest = (context: Context, model: { id: string }, maxTokens?: number) =>
  convertNative(normalizeContext(context), model, maxTokens);

const model = { id: "claude-offline-test" };
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant", content, api: "anthropic-messages", provider: "claude-cli", model: model.id,
  usage, timestamp: 73, stopReason: "stop",
});
const user = (content = "continue"): Context => ({ messages: [{ role: "user", content, timestamp: 71 }] });
const tool = { name: "lookup", description: "Read a value", parameters: { type: "object", properties: {} } };
const native = { type: "claude-subscription-directsdk-experimental.native_assistant", version: 1,
  messages: [{ role: "assistant", content: [
    { type: "thinking", thinking: "opaque", signature: "signed-native-block" }, { type: "text", text: "answer" },
  ] }], projection: { content: "answer", tool_calls: [] } };
const response: NativeResponse = { id: "msg-test", model: model.id,
  choices: [{ finish_reason: "stop", message: { content: "answer", tool_calls: null, reasoning_details: [native] } }],
  usage: { native_usage: { input_tokens: 1, output_tokens: 2 } } };
test("structured conversion preserves message boundaries, host results, images, and current tools", () => {
  const image = { type: "image" as const, mimeType: "image/png", data: "AA==" };
  const context: Context = { messages: [
    { role: "system", content: "  base policy  ", toolsAdded: [tool], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "inspect" }, image], timestamp: 2 },
    assistant([{ type: "text", text: "calling " }, { type: "thinking", thinking: "foreign-secret", thinkingSignature: "foreign-sig" },
      { type: "text", text: "lookup" }, { type: "toolCall", id: "call-1", name: "lookup", arguments: { key: "actual" } }]),
    { role: "system", content: "new rule", toolsRemoved: [{ name: "lookup" }], toolsAdded: [{ ...tool, name: "next" }], timestamp: 4 },
    { role: "toolResult", toolName: "lookup", toolCallId: "call-1", content: [{ type: "text", text: "real-host-value" }, image],
      isError: true, details: { private: "not-for-model" }, timestamp: 5 },
  ] };
  const request = prepareNativeRequest(context, model, 1234);
  assert.equal(request.messages.length, 4);
  assert.deepEqual(request.messages[0], { role: "system", content: "  base policy  \n\nnew rule" });
  const nativeImage = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
  assert.deepEqual(request.messages[1], { role: "user", content: [{ type: "text", text: "inspect" }, nativeImage] });
  assert.deepEqual(request.messages[2], { role: "assistant", content: "calling lookup", tool_calls: [
    { id: "call-1", type: "function", function: { name: "lookup", arguments: '{"key":"actual"}' } },
  ] });
  assert.deepEqual(request.messages[3], { role: "tool", tool_call_id: "call-1", is_error: true,
    content: [{ type: "text", text: "real-host-value" }, nativeImage] });
  assert.deepEqual(request.tools.map(t => t.function.name), ["next"]);
  assert.equal(request.max_tokens, 1234);
  assert.doesNotMatch(JSON.stringify(request), /foreign-secret|foreign-sig|not-for-model|timestamp|totalTokens|stopReason/);
});

test("native carriers roundtrip only for the same provider and model; malformed markers fail closed", () => {
  const signature = nativeResponseCarrier(response);
  const original = assistant([{ type: "text", text: "answer", textSignature: signature }]);
  const convert = (a: AssistantMessage) => prepareNativeRequest({ messages: [a, ...user().messages] }, model).messages[0]!;
  assert.deepEqual(convert(original).reasoning_details, [native]);
  assert.equal(convert({ ...original, provider: "other" }).reasoning_details, undefined);
  assert.equal(convert({ ...original, model: "other" }).reasoning_details, undefined);
  assert.equal(convert(assistant([{ type: "text", text: "answer", textSignature: "foreign-signature" }])).reasoning_details, undefined);
  const edited = convert(assistant([{ type: "text", text: "host-edited", textSignature: signature }]));
  assert.equal(edited.content, "host-edited");
  assert.deepEqual(edited.reasoning_details, [native], "DirectSDK must compare the projection, not overwrite host edits");
  for (const bad of ["luna-claude-native-v1:not-json", 'luna-claude-native-v1:{"v":2}',
    `luna-claude-native-v1:${JSON.stringify({ v: 1, model: model.id, reasoning_details: [{ type: "forged" }] })}`]) {
    assert.throws(() => convert(assistant([{ type: "text", text: "answer", textSignature: bad }])), /carrier/i);
  }
});

test("no input-size guard: large histories convert unchanged", () => {
  const big = "x".repeat(1_300_000);
  assert.equal((prepareNativeRequest(user(big), model).messages[0] as { content: string }).content, big);
});
