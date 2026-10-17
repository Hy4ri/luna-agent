// Offline behavioral tests: call the real converter and child-process transport.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import { prepareNativeRequest as convertNative, nativeResponseCarrier, runNativeRequest, type NativeResponse } from "./claude-native.js";
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
const previousBudget = process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES;
const previousPython = process.env.LUNA_CLAUDE_PYTHON;
delete process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES;
const dir = mkdtempSync(join(tmpdir(), "luna-claude-native-test-"));
const marker = join(dir, "spawned");
const fixture = join(dir, "fake-python");
writeFileSync(marker, "");
writeFileSync(fixture, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(marker)}, String(process.pid)+'\\n');
let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',s=>input+=s);
process.stdin.on('end',()=>{
  const {command:mode,request}=JSON.parse(input);
  const response={id:'msg-fixture',model:request.model,choices:[{finish_reason:'stop',message:{content:'Hello λ🙂',reasoning_content:'think',tool_calls:null}}],usage:{native_usage:{input_tokens:11,output_tokens:7,cache_read_input_tokens:13,cache_creation_input_tokens:17}}};
  const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  if(mode==='hang'){out({type:'delta',text:'started'});setInterval(()=>{},1000);return;}
  if(mode==='error'){out({type:'error',message:'fixture rejection',statusCode:429});return;}
  if(mode==='missing'){out({type:'delta',text:'partial'});return;}
  if(mode==='malformed')process.stdout.write('not-json\\n');
  if(mode==='incomplete'){process.stdout.write('{"type":');return;}
  if(mode==='invalid-usage')response.usage={};
  if(mode==='echo'){response.choices[0].message.content=JSON.stringify({args:process.argv.slice(2),request,claudecode:process.env.CLAUDECODE});}
  if(mode==='unicode'){
    const bytes=Buffer.from(JSON.stringify({type:'delta',text:'Hello λ🙂'})+'\\n');
    for(const byte of bytes)process.stdout.write(Buffer.from([byte]));
  }else if(mode==='ok'){out({type:'delta',text:'Hello λ🙂'});}
  if(mode==='ok')out({type:'thinking',text:'think'});
  out({type:'response',response});
  if(mode==='duplicate')out({type:'response',response});
  if(mode==='tail')process.stdout.write('unframed tail');
  if(mode==='nonzero')process.exitCode=4;
});
`, { mode: 0o700 });
process.env.LUNA_CLAUDE_PYTHON = fixture;
after(() => {
  if (previousBudget === undefined) delete process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES;
  else process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES = previousBudget;
  if (previousPython === undefined) delete process.env.LUNA_CLAUDE_PYTHON;
  else process.env.LUNA_CLAUDE_PYTHON = previousPython;
  rmSync(dir, { recursive: true, force: true });
});

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

test("byte guard counts the exact structured request; metadata never consumes the input budget", () => {
  const small = user("🙂 exact request");
  const baseline = prepareNativeRequest(small, model);
  const size = Buffer.byteLength(JSON.stringify(baseline));
  process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES = String(size);
  assert.deepEqual(prepareNativeRequest(small, model), baseline);
  process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES = String(size - 1);
  assert.throws(() => prepareNativeRequest(small, model), /Compact/);
  for (const invalid of ["", "0", "-1", "NaN", "Infinity", "1.5", "9007199254740992"]) {
    process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES = invalid;
    assert.throws(() => prepareNativeRequest(small, model), /positive safe integer/);
  }
  delete process.env.LUNA_CLAUDE_MAX_PROMPT_BYTES;
  assert.throws(() => prepareNativeRequest(user("x".repeat(1_300_000)), model), /Compact/);
  for (const context of [
    { messages: [{ role: "system", content: "s".repeat(131072), timestamp: 1 }, ...user().messages] },
    { messages: [{ role: "system", content: "", toolsAdded: [{ ...tool, description: "s".repeat(131072) }], timestamp: 1 }, ...user().messages] },
  ] as Context[]) assert.throws(() => prepareNativeRequest(context, model), /Compact/);
  const hugeMetadata = assistant([{ type: "text", text: "hello" }]);
  hugeMetadata.responseId = "x".repeat(1_300_000);
  assert.doesNotThrow(() => prepareNativeRequest({ messages: [hugeMetadata, ...user().messages] }, model));
});

const run = (mode: string, signal?: AbortSignal, onText = (_text: string) => {}) => runNativeRequest(
  prepareNativeRequest(user(), model), { executable: mode, signal, onText, onThinking: () => {} });

test("real subprocess transport streams text/thinking and preserves split UTF-8", async () => {
  let text = "", thinking = "";
  const result = await runNativeRequest(prepareNativeRequest(user(), model), { executable: "ok",
    onText: s => { text += s; }, onThinking: s => { thinking += s; } });
  assert.equal(text, "Hello λ🙂");
  assert.equal(thinking, "think");
  assert.equal(result.usage.native_usage.cache_creation_input_tokens, 17);
  let unicode = "";
  await run("unicode", undefined, s => { unicode += s; });
  assert.equal(unicode, "Hello λ🙂");
});

test("transport passes framed history and explicit executable; nested CLI marker is removed", async () => {
  const before = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "parent-cli";
  try {
    const result = await run("echo");
    const seen = JSON.parse(result.choices[0]!.message.content!);
    assert.deepEqual(seen.args.slice(0, 2), ["-B", "-u"]);
    assert.match(seen.args[2], /claude-native\/bridge\.py$/);
    assert.equal(seen.request.messages[0].role, "user");
    assert.equal(seen.claudecode, undefined);
  } finally {
    if (before === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = before;
  }
});

test("malformed, duplicate, incomplete, failed, and usage-less streams never complete", async () => {
  for (const mode of ["malformed", "duplicate", "incomplete", "missing", "nonzero", "tail", "invalid-usage", "error"]) {
    await assert.rejects(run(mode), Error, mode);
  }
});

test("pre-abort does not spawn; active abort waits for process cleanup", async () => {
  const pre = new AbortController(); pre.abort();
  const before = readFileSync(marker, "utf8");
  await assert.rejects(run("ok", pre.signal), { name: "AbortError" });
  assert.equal(readFileSync(marker, "utf8"), before);
  const controller = new AbortController();
  const start = Date.now();
  await assert.rejects(run("hang", controller.signal, () => controller.abort()), { name: "AbortError" });
  assert.ok(Date.now() - start < 3000, "abort must not leave a five-second cleanup timer active");
  const pid = Number(readFileSync(marker, "utf8").trim().split("\n").at(-1));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the owned fake bridge must be gone when cancellation returns");
});
