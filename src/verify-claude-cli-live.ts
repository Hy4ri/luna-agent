// Opt-in live check: uses the authenticated Claude CLI. Not part of offline tests.
import assert from "node:assert/strict";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { claudeCliProvider } from "./claude-cli.js";
const models = createModels();
models.setProvider(claudeCliProvider());
const refreshed = await models.refresh({ providers: ["claude-cli"], allowNetwork: true });
assert.equal(refreshed.errors.size, 0);
const ids = models.getModels("claude-cli").map(m => m.id);
assert.ok(ids.length > 2 && ids.some(id => id.includes("haiku")));
console.log("OK: CLI catalog refreshed:", ids.join(", "));
const model = models.getModel("claude-cli", "claude-sonnet-4-6")!;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90000);
try {
 const context: Context = {
  systemPrompt: "You are a test assistant. Use the requested tool. Never invent its result.",
  tools: [{ name: "get_secret", description: "Get the secret value from the host.", parameters: { type: "object", properties: {}, required: [] } }],
  messages: [{ role: "user", content: "Call get_secret, then tell me its value.", timestamp: Date.now() }],
 };
 const first = await models.streamSimple(model, context, { signal: controller.signal }).result();
 assert.equal(first.stopReason, "toolUse", first.errorMessage ?? JSON.stringify(first));
 const call = first.content.find(b => b.type === "toolCall");
 assert.ok(call && call.name === "get_secret");
 console.log("OK: CLI returned luna tool call without executing it");
 context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name,
  content: [{ type: "text", text: "host-secret-91827" }], isError: false, timestamp: Date.now() });
 const second = await models.streamSimple(model, context, { signal: controller.signal }).result();
 assert.equal(second.stopReason, "stop", second.errorMessage ?? JSON.stringify(second));
 assert.ok(second.content.some(b => b.type === "text" && b.text.includes("host-secret-91827")), JSON.stringify(second));
 console.log("OK: follow-up used the real host tool result");
} finally { clearTimeout(timer); }
