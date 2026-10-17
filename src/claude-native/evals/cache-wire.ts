// Offline native cache-prefix regression (no inference or account credentials).
// Run: pnpm run verify:claude-cli:wire /absolute/path/to/claude [--model claude-sonnet-5]
// Uses the real transport and native binary with a synthetic loopback Messages peer.
// Checks exact cached-prefix reuse, not cache hit rates; usage is deliberately synthetic.
// After a tool loop longer than the cache lookback, the next turn must carry a breakpoint on the
// prefix written before the loop's first thinking block (#122). Only hash receipts are printed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deepEqual } from "../history.js";
import { runClaude } from "../transport.js";
import type { NativeMessage, NativeRequest } from "../types.js";

type Json = Record<string, any>;
const THINKING = { type: "thinking", thinking: "PUBLIC SYNTHETIC THINKING", signature: "public-fixture-opaque-signature" };
const TOOLS: NativeRequest["tools"] = [{ type: "function", function: { name: "probe", description: "Public probe",
  parameters: { type: "object", properties: {} } } }];
const USAGE = { input_tokens: 101, output_tokens: 37, cache_read_input_tokens: 211, cache_creation_input_tokens: 313 };
// Pure tool continuation, two ordinary user turns, then a 14-round loop with thinking and the turn after it.
const SCHEDULE = [true, true, false, false, ...Array(14).fill(true), false, true];
const LOOKBACK = 20;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted((value as Json)[k])]));
  }
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(sorted(value))).digest("hex");
function cut(prompt: Json, [i, j]: [number, number]): Json {
  const prefix = structuredClone(prompt);
  prefix.messages = prefix.messages.slice(0, i + 1);
  prefix.messages.at(-1).content = prefix.messages.at(-1).content.slice(0, j + 1);
  return prefix;
}
function* nodes(value: unknown): Generator<Json> {
  if (Array.isArray(value)) for (const item of value) yield* nodes(item);
  else if (value && typeof value === "object") {
    yield value as Json;
    for (const item of Object.values(value)) yield* nodes(item);
  }
}
// Directives move to the newest breakpoint; they are not cached prompt text.
function content(value: unknown): any {
  if (Array.isArray(value)) return value.map(content);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "cache_control").map(([k, v]) => [k, content(v)]));
  }
  return value;
}
const messageMarks = (wire: Json) => wire.messages.flatMap((msg: Json, i: number) => Array.isArray(msg.content)
  ? msg.content.flatMap((block: Json, j: number) => "cache_control" in block ? [[i, j] as [number, number]] : []) : []);

async function run(binary: string, model: string) {
  const wires: Json[] = [];
  let tools = true;
  const peer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/messages/count_tokens") { res.end('{"input_tokens":100}'); return; }
      if (req.method !== "POST" || path !== "/v1/messages") { res.writeHead(403).end(); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      wires.push(body);
      const n = wires.length;
      const blocks = tools ? [THINKING, { type: "tool_use", id: `toolu_public_${n}`, name: body.tools[0].name, input: {} }]
        : [{ type: "text", text: "PUBLIC SYNTHETIC ANSWER" }];
      const stop = tools ? "tool_use" : "end_turn";
      const message = { id: `msg_public_${n}`, type: "message", role: "assistant", model: body.model, content: blocks,
        stop_reason: stop, stop_sequence: null, usage: USAGE };
      res.writeHead(200, { "content-type": "text/event-stream" });
      const emit = (event: Json) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      emit({ type: "message_start", message: { ...message, content: [], stop_reason: null } });
      blocks.forEach((block: Json, index) => {
        const start = block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" }
          : block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" };
        emit({ type: "content_block_start", index, content_block: start });
        const deltas = block.type === "thinking"
          ? [{ type: "thinking_delta", thinking: block.thinking }, { type: "signature_delta", signature: block.signature }]
          : block.type === "tool_use" ? [{ type: "input_json_delta", partial_json: JSON.stringify(block.input) }]
          : [{ type: "text_delta", text: block.text }];
        for (const delta of deltas) emit({ type: "content_block_delta", index, delta });
        emit({ type: "content_block_stop", index });
      });
      emit({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: USAGE });
      emit({ type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>(done => peer.listen(0, "127.0.0.1", done));
  const tmp = mkdtempSync(join(tmpdir(), "claude-cache-wire-"));
  try {
    const port = (peer.address() as { port: number }).port;
    const proxy = "http://127.0.0.1:1";
    const env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: tmp, CLAUDE_CONFIG_DIR: join(tmp, "config"),
      XDG_CONFIG_HOME: tmp, ANTHROPIC_API_KEY: "sk-ant-public-fixture-not-a-credential",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy };
    const version = execFileSync(binary, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).toString().trim();
    const history: NativeMessage[] = [{ role: "system", content: "PUBLIC SYNTHETIC SYSTEM\n".repeat(300) }];
    for (let i = 0; i < 12; i++) {
      history.push({ role: "user", content: `Public earlier question ${i}` }, { role: "assistant", content: `Public earlier answer ${i}` });
    }
    history.push({ role: "user", content: "Run the public probe." });
    const receipts: Json[] = [];
    const written = new Set<string>();
    const followups: string[] = [];
    let previous: [Json, unknown[], [number, number]] | undefined;
    let markers: unknown[] = [];
    for (const [round, withTools] of SCHEDULE.entries()) {
      tools = withTools;
      const original = structuredClone(history);
      const start = wires.length;
      const result = await runClaude({ model, messages: history, tools: TOOLS, stream: true },
        { executable: binary, env, timeoutMs: 45_000, onText: () => {}, onThinking: () => {} });
      assert.ok(deepEqual(history, original), "caller history mutated");
      assert.equal(wires.length, start + 1, "unexpected extra inference request");
      const wire = wires.at(-1)!;
      markers = [...nodes(wire)].filter(node => "cache_control" in node).map(node => node.cache_control);
      const fixed = [...wire.tools, ...wire.system].map((block: Json) => block.cache_control ?? null);
      const marks = messageMarks(wire);
      assert.ok(markers.length <= 4 && marks.length >= 1 && marks.length <= 2, "extra cache breakpoints");
      assert.ok(markers.every(marker => deepEqual(marker, markers[0])), "mixed native cache TTLs");
      const prompt = content({ tools: wire.tools, system: wire.system, messages: wire.messages });
      if (previous) {
        const [old, oldFixed, at] = previous;
        const candidate = cut(prompt, at);
        assert.ok(deepEqual(candidate, old), `cached prefix changed at round ${round}: ${digest(old)} != ${digest(candidate)}`);
        assert.ok(deepEqual(fixed, oldFixed), "native cache TTL/breakpoint policy changed");
        receipts.push({ round, old_prefix_sha256: digest(old), replayed_prefix_sha256: digest(candidate) });
      }
      if (round === SCHEDULE.length - 1) {
        // The turn after the long loop: the recurring breakpoint is too far from the loop's opening frame,
        // so a second one must sit on it, on a prefix an earlier request wrote.
        const [[i, j], last] = [marks[0]!, marks.at(-1)!];
        const opening = wire.messages.findIndex((msg: Json) => msg.role === "user" && Array.isArray(msg.content) &&
          content(msg.content).some((b: Json) => deepEqual(b, { type: "text", text: followups.at(-2) })));
        assert.ok(marks.length === 2 && i === opening, `no breakpoint on the loop's opening frame: ${JSON.stringify(marks)}`);
        const span = wire.messages.slice(i, last[0]).reduce((n: number, msg: Json) =>
          n + (Array.isArray(msg.content) ? msg.content.length : 1), 0) - j + last[1] + 1;
        assert.ok(span > LOOKBACK && written.has(digest(cut(prompt, [i, j]))), "turn breakpoint not on a written prefix");
        receipts.push({ round, turn_breakpoint: [i, j], positions_to_recurring: span });
      }
      for (const at of marks) written.add(digest(cut(prompt, at)));
      previous = [cut(prompt, marks.at(-1)!), fixed, marks.at(-1)!];
      if ([1, 2, 5].includes(round)) assert.ok([...nodes(wire.messages)].some(n => deepEqual(n, THINKING)), "signed thinking lost or changed");
      const message = result.choices[0]!.message;
      history.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls ?? undefined,
        reasoning_details: message.reasoning_details ?? undefined });
      if (withTools) {
        for (const call of message.tool_calls ?? []) {
          history.push({ role: "tool", tool_call_id: call.id, content: "Public tool result\n".repeat(1000) });
        }
      } else {
        followups.push(`Public followup ${round}`);
        history.push({ role: "user", content: followups.at(-1)! });
      }
    }
    assert.ok(wires.every(wire => !JSON.stringify(wire).includes("<total_tokens>")), "native budget reminder present");
    assert.ok(wires[0]!.messages.reduce((n: number, msg: Json) => n + msg.content.length, 0) > 20);
    return { native_version: version, native_sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      requests: wires.length, synthetic_usage_not_cache_measurement: true, cache_controls: markers, prefix_receipts: receipts };
  } finally {
    peer.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const binary = args.find(a => !a.startsWith("--"));
if (!binary) throw new Error("usage: cache-wire.ts /absolute/path/to/claude [--model id]");
const model = args.includes("--model") ? args[args.indexOf("--model") + 1]! : "claude-sonnet-5";
console.log(JSON.stringify(await run(resolve(binary), model), null, 2));
console.log("CLAUDE_CACHE_WIRE_OK");
