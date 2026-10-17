// Process-level transport tests: real runClaude and the real pi provider against a fake Claude CLI.
// Port of the Python bridge tests. The fake records frames, argv, and env; it never POSTs to the relay.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { claudeCliProvider } from "./claude-cli.js";
import { runClaude } from "./claude-native/transport.js";
import type { NativeMessage, NativeRequest } from "./claude-native/types.js";

const dir = mkdtempSync(join(tmpdir(), "luna-claude-transport-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const receipt = join(dir, "receipt.jsonl");
const fake = join(dir, "fake-claude");
const CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_FOUNDRY_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE"];
for (const key of CONFLICTS) delete process.env[key];

// Modes: ok, hang, tool, truncated, roundtrip, malformed, noresult, failed.
writeFileSync(fake, `#!${process.execPath}
const fs = require("node:fs");
const record = row => fs.appendFileSync(process.env.RECEIPT, JSON.stringify(row) + "\\n");
const out = row => process.stdout.write(JSON.stringify(row) + "\\n");
const mode = process.env.FAKE_MODE;
const settings = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf("--settings") + 1], "utf8"));
record({ argv: process.argv.slice(2), claudecode: process.env.CLAUDECODE ?? null, base: process.env.ANTHROPIC_BASE_URL,
  extra: JSON.parse(settings.env.CLAUDE_CODE_EXTRA_BODY), cwd: process.cwd(), pid: process.pid });
const usage = { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 13, cache_creation_input_tokens: 17 };
const frames = [];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    frames.push(frame);
    record({ frame });
    if (frame.shouldQuery === false) out({ type: "result", num_turns: 0, is_error: false });
  }
});
process.stdin.on("end", () => {
  const finish = (content, stop, subtype, code) => {
    const message = { id: "msg-fixture", role: "assistant", content, stop_reason: stop, usage };
    out({ type: "assistant", message });
    out({ type: "stream_event", event: { type: "message_stop" } });
    out({ type: "result", subtype, is_error: code !== 0, usage });
    process.exitCode = code;
  };
  const latest = frames.at(-1).message.content;
  if (mode === "hang") {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "started" } } });
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "malformed") { process.stdout.write("Welcome banner\\n"); return; }
  if (mode === "noresult") { out({ type: "assistant", message: { content: [{ type: "text", text: "x" }], usage } }); return; }
  if (mode === "failed") return finish([{ type: "text", text: "x" }], "end_turn", "success", 3);
  const tool = [{ type: "thinking", thinking: "native thought", signature: "opaque-signature" },
    { type: "tool_use", id: "call-actual", name: "mcp__hermes__lookup", input: {} }];
  if (mode === "truncated") return finish(tool.slice(1), process.env.FAKE_STOP, "error_max_turns", 1);
  if (mode === "tool" || (mode === "roundtrip" && latest[0].type !== "tool_result")) return finish(tool, "tool_use", "error_max_turns", 1);
  const text = mode === "roundtrip" ? latest[0].content.find(b => b.type === "text").text : "Hello λ";
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, 3) } } });
  finish([{ type: "text", text }], "end_turn", "success", 0);
});
`);
chmodSync(fake, 0o700);
process.env.RECEIPT = receipt;

const rows = () => existsSync(receipt) ? readFileSync(receipt, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
const reset = (mode: string, extra: Record<string, string> = {}) => {
  rmSync(receipt, { force: true });
  process.env.FAKE_MODE = mode;
  Object.assign(process.env, extra);
};
const lookup = { type: "function" as const, function: { name: "lookup", description: "Read a value", parameters: { type: "object", properties: {} } } };
const request = (messages: NativeMessage[], tools = [lookup]): NativeRequest => ({ model: "claude-offline-test", messages, tools, stream: true });
const run = (req: NativeRequest, options: { signal?: AbortSignal; onText?: (t: string) => void; executable?: string } = {}) =>
  runClaude(req, { executable: options.executable ?? fake, signal: options.signal, onText: options.onText ?? (() => {}), onThinking: () => {} });

test("history replays as native frames; only the newest user frame queries", async () => {
  reset("ok");
  const deltas: string[] = [];
  const response = await run(request([{ role: "user", content: "old" }, { role: "assistant", content: "old answer" },
    { role: "user", content: "latest" }]), { onText: t => deltas.push(t) });
  assert.equal(response.choices[0]!.message.content, "Hello λ");
  assert.equal(response.choices[0]!.finish_reason, "stop");
  assert.deepEqual(deltas, ["Hel", "lo λ"], "streamed prefix, then the final suffix");
  const frames = rows().filter(r => r.frame).map(r => r.frame);
  assert.deepEqual(frames.map(f => f.type), ["user", "assistant", "user"]);
  assert.equal(frames[0].shouldQuery, false);
  assert.equal("shouldQuery" in frames[2], false);
  assert.deepEqual(frames[2].message.content, [{ type: "text", text: "latest" }]);
  assert.equal(response.usage.native_usage.cache_creation_input_tokens, 17);
});

test("argv, settings, relay, and session id are stable per conversation", async () => {
  reset("ok");
  process.env.CLAUDECODE = "parent";
  try {
    await run(request([{ role: "system", content: "policy" }, { role: "user", content: "first" }]));
  } finally { delete process.env.CLAUDECODE; }
  const first = rows()[0];
  const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1] ?? "";
  assert.equal(flag(first.argv, "--max-turns"), "1");
  assert.equal(flag(first.argv, "--tools"), "");
  assert.equal(flag(first.argv, "--input-format"), "stream-json");
  assert.match(flag(first.argv, "--session-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first.claudecode, null, "a nested CLI marker is not inherited");
  assert.match(first.base, /^http:\/\/127\.0\.0\.1:\d+\/admit\/[\w-]{43}$/);
  assert.deepEqual(first.extra.tools.map((t: { name: string }) => t.name), ["mcp__hermes__lookup"]);
  assert.equal(JSON.parse(flag(first.argv, "--mcp-config")).mcpServers.hermes.command, process.execPath);
  reset("ok");
  await run(request([{ role: "system", content: "policy" }, { role: "user", content: "first" },
    { role: "assistant", content: "answer" }, { role: "user", content: "second" }]));
  assert.equal(flag(rows()[0].argv, "--session-id"), flag(first.argv, "--session-id"), "the cache prefix must not move");
  assert.equal(rows()[0].cwd, first.cwd, "native's cwd is part of the cached environment message");
});

test("missing CLI and conflicting auth fail before spawn", async () => {
  reset("ok");
  await assert.rejects(run(request([{ role: "user", content: "hi" }]), { executable: join(dir, "missing") }),
    (error: { statusCode?: number }) => error.statusCode === 503);
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_VERTEX"]) {
    process.env[key] = "fixture-conflict";
    try { await assert.rejects(run(request([{ role: "user", content: "hi" }])), /conflicting/, key); }
    finally { delete process.env[key]; }
  }
  assert.equal(existsSync(receipt), false, "nothing may spawn");
});

test("a truncated batch finishes as length, never as actionable tools", async () => {
  for (const stop of ["max_tokens", "model_context_window_exceeded"]) {
    reset("truncated", { FAKE_STOP: stop });
    const response = await run(request([{ role: "user", content: "Call lookup" }]));
    assert.equal(response.choices[0]!.finish_reason, "length", stop);
  }
});

test("malformed, incomplete, and failed native runs never complete", async () => {
  for (const [mode, pattern] of [["malformed", /Invalid native stream-json/], ["noresult", /Incomplete native response/],
    ["failed", /Native request failed/]] as const) {
    reset(mode);
    await assert.rejects(run(request([{ role: "user", content: "hi" }])), pattern, mode);
  }
});

test("abort kills the owned process group before rejecting", async () => {
  reset("hang");
  const pre = new AbortController(); pre.abort();
  await assert.rejects(run(request([{ role: "user", content: "hi" }]), { signal: pre.signal }), { name: "AbortError" });
  assert.equal(existsSync(receipt), false, "a pre-aborted request does not spawn");
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(run(request([{ role: "user", content: "hi" }]), { signal: controller.signal, onText: () => controller.abort() }),
    { name: "AbortError" });
  assert.ok(Date.now() - start < 3000);
  const pid = rows()[0].pid;
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the fake CLI must be gone when cancellation returns");
});

test("pi provider roundtrip: tool call, signed carrier, real host result; no size guard", async () => {
  reset("roundtrip", { LUNA_CLAUDE_EXECUTABLE: fake });
  const models = createModels();
  models.setProvider(claudeCliProvider());
  const model = models.getModels("claude-cli")[0]!;
  const context: Context = { systemPrompt: "Use actual host results.",
    tools: [{ name: "lookup", description: "Read a value", parameters: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "Look up the value.", timestamp: 1 }] };
  const first = await models.streamSimple(model, context).result();
  assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "tool turn failed");
  const call = first.content.find(b => b.type === "toolCall");
  assert.ok(call && call.type === "toolCall" && call.name === "lookup");
  assert.ok(first.content.some(b => b.type === "text" && b.textSignature?.includes("opaque-signature")));
  context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, isError: true,
    content: [{ type: "text", text: "actual host failure" }, { type: "image", mimeType: "image/png", data: "AA==" }], timestamp: 2 });
  rmSync(receipt, { force: true });
  const second = await models.streamSimple(model, context).result();
  assert.equal(second.stopReason, "stop", second.errorMessage ?? "result turn failed");
  assert.equal(second.usage.totalTokens, 48);
  const frames = rows().filter(r => r.frame).map(r => r.frame);
  assert.deepEqual(frames.map(f => f.type), ["user", "assistant", "user"]);
  assert.deepEqual(frames[1].message.content[0], { type: "thinking", thinking: "native thought", signature: "opaque-signature" });
  assert.deepEqual(frames[2].message.content, [{ type: "tool_result", tool_use_id: "call-actual", is_error: true, content: [
    { type: "text", text: "actual host failure" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }] }]);

  reset("ok");
  const large = await models.streamSimple(model, { messages: [{ role: "user", content: "x".repeat(1_300_000), timestamp: 3 }] }).result();
  assert.equal(large.stopReason, "stop", large.errorMessage ?? "large turn failed");
  assert.equal(rows().filter(r => r.frame)[0].frame.message.content[0].text.length, 1_300_000);
});
