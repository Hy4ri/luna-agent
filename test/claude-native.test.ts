// Contract: the native Claude transport keeps the prompt-cache prefix byte-stable and admits one native request with bounded network retries.
// fixtures/claude-native-python-parity.json holds outputs captured from the retired Python DirectSDK transport.
// A change here moves the cache prefix of every existing conversation, so a diff must be deliberate.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test, expect } from "bun:test";
import { Admission, Capture, QueriedTurnMismatch, dropNativeContext, pinMessageBreakpoint, restoreQueriedTurn,
  stableRequestContext, upstreamProxy } from "../src/claude-native/admission.js";
import { CARRIER_TYPE, TOOL_PREFIX, buildBody, conversationSessionId, conversationToolPrefix, deepEqual, nativeModel,
  prepareHistory } from "../src/claude-native/history.js";
import { rejectsWith, throwsWith } from "./support/expect-error.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/claude-native-python-parity.json", import.meta.url), "utf8"));
const same = (actual: unknown, expected: unknown, message: string) =>
  expect(deepEqual(actual, expected), `${message}\n got: ${JSON.stringify(actual)}\nwant: ${JSON.stringify(expected)}`).toBeTruthy();

test("cache transforms match the recorded outputs", () => {
  const transforms = { restore: restoreQueriedTurn, stable: stableRequestContext, pin: pinMessageBreakpoint };
  for (const c of ref.cases) {
    for (const [name, fn] of Object.entries(transforms)) {
      const input = Buffer.from(c.raw, "utf8");
      let got: unknown;
      try {
        const out = fn(input, c.queried);
        // An unchanged payload must be forwarded as the identical bytes.
        got = out.equals(input) ? { same: true, value: null } : { same: false, value: JSON.parse(out.toString("utf8")) };
      } catch (error) {
        expect(error instanceof QueriedTurnMismatch, `${c.name}/${name}: ${error}`).toBeTruthy();
        got = { throws: true };
      }
      same(got, c.python[name], `${c.name}/${name}`);
    }
  }
});

// Shapes recorded from Claude Code 2.1.312 through runClaude; the account address is redacted.
const ACCOUNT_REMINDER = "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# userEmail\n"
  + "The user's email address is user@example.invalid. Use it only to identify the user.\n</system-reminder>\n";
const MENTION = "The user @-mentioned /tmp/note.txt. File contents are not attached automatically in this session: "
  + "if these are files or directories in your working directory, read them with your file tools before responding.\n\n";
const ENV = "# Environment\nYou have been invoked in the following environment: \n - Platform: linux";

test("native account and file-mention context never reaches upstream", () => {
  const mark = { type: "ephemeral", ttl: "1h" };
  const run = (body: unknown, luna: string[]) => {
    const input = Buffer.from(JSON.stringify(body), "utf8");
    const out = dropNativeContext(input, luna);
    return out.equals(input) ? null : JSON.parse(out.toString("utf8"));
  };
  // First turn: the reminder follows Luna's text and the mention notice leads the environment message.
  same(run({ messages: [
    { role: "user", content: [{ type: "text", text: "first turn @/tmp/note.txt", cache_control: mark }, { type: "text", text: ACCOUNT_REMINDER }] },
    { role: "system", content: [{ type: "text", text: MENTION + ENV }] },
  ] }, ["first turn @/tmp/note.txt"]), { messages: [
    { role: "user", content: [{ type: "text", text: "first turn @/tmp/note.txt", cache_control: mark }] },
    { role: "system", content: [{ type: "text", text: ENV }] },
  ] }, "first turn");
  // Later turn: a mention notice before the date line leaves only the date line, which stableRequestContext folds.
  same(run({ messages: [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "system", content: ENV },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "text", text: "second @/tmp/note.txt", cache_control: mark }] },
    { role: "system", content: [{ type: "text", text: MENTION + "Today's date is 2026-11-08." }] },
  ] }, ["first", "second @/tmp/note.txt"]).messages.at(-1), { role: "system", content: [{ type: "text", text: "Today's date is 2026-11-08." }] }, "later turn");
  // A mark on a dropped block moves to the block before it.
  same(run({ messages: [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
    { type: "text", text: ACCOUNT_REMINDER, cache_control: mark }] }] }, ["look"]).messages[0].content.at(-1),
  { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" }, cache_control: mark }, "moved mark");
  // Luna's own reminder text is never dropped, and a clean payload keeps its bytes.
  expect(run({ messages: [{ role: "user", content: [{ type: "text", text: ACCOUNT_REMINDER }] }] }, [ACCOUNT_REMINDER])).toBe(null);
  expect(run({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "system", content: ENV }] }, ["hi"])).toBe(null);
});

test("history frames and session ids match the recorded outputs and do not mutate input", () => {
  for (const h of ref.histories) {
    const input = structuredClone(h.input);
    const { system, frames } = prepareHistory(input, new Map([["lookup", "lookup"]]));
    expect(system).toBe(h.system);
    same(frames, h.frames, "frames");
    same(input, h.input, "input must not be mutated");
    expect(conversationSessionId(system, frames), "a changed id moves the cache prefix").toBe(h.session);
  }
});

test("model routes match the recorded outputs", () => {
  for (const [model, want] of Object.entries(ref.models)) {
    if (want === "THROWS") throwsWith(() => nativeModel(model), /1M/, model);
    else expect(nativeModel(model) as unknown, model).toBe(want);
  }
});

// The recording predates the rename to mcp__luna__ (#203). Conversations started before it keep the legacy
// prefix, because signed tool-use blocks cannot be renamed, so the recording proves the legacy path byte for byte.
const LEGACY_PREFIX = "mcp__hermes__";

test("request body matches the recorded output and rejects invalid tools", () => {
  const built = buildBody(ref.body.request, LEGACY_PREFIX);
  expect(built.body).toBe(ref.body.body);
  same(built.manifest, ref.body.manifest, "manifest");
  same(Object.fromEntries(built.names), ref.body.names, "names");
  const tool = (name: string) => ({ type: "function" as const, function: { name, description: "", parameters: { type: "object" } } });
  throwsWith(() => buildBody({ model: "m", messages: [], stream: true, tools: [tool("a"), tool("a")] }), /unique/);
  throwsWith(() => buildBody({ model: "m", messages: [], stream: true, tools: [tool("bad name")] }), /ASCII identifiers/);
  throwsWith(() => buildBody({ model: "m", messages: [], stream: true, tools: [], max_tokens: 0 }), /positive/);
});

test("new conversations use the Luna prefix and carriers keep their recorded prefix", () => {
  expect(TOOL_PREFIX).toBe("mcp__luna__");
  const fresh = buildBody(ref.body.request).body;
  expect(fresh).toBe((buildBody(ref.body.request, LEGACY_PREFIX).body as string).replaceAll(LEGACY_PREFIX, TOOL_PREFIX));
  const carrier = (detail: Record<string, unknown>) => [{ role: "assistant" as const, content: "", reasoning_details: [{ type: CARRIER_TYPE, ...detail }] }];
  expect(conversationToolPrefix([])).toBe(TOOL_PREFIX);
  expect(conversationToolPrefix(carrier({ wirePrefix: LEGACY_PREFIX }))).toBe(LEGACY_PREFIX);
  // Older carriers have no marker; the prefix comes from their signed tool-use names.
  expect(conversationToolPrefix(carrier({ messages: [{ content: [{ type: "tool_use", name: "mcp__hermes__lookup" }] }] }))).toBe(LEGACY_PREFIX);
  throwsWith(() => conversationToolPrefix([...carrier({ wirePrefix: LEGACY_PREFIX }), ...carrier({ wirePrefix: TOOL_PREFIX })]), /Conflicting/);
  throwsWith(() => conversationToolPrefix(carrier({ wirePrefix: "evil" })), /Unsupported/);
});

test("SSE capture is independent of chunk boundaries, including split UTF-8", () => {
  for (const c of ref.captures) {
    const raw = Buffer.from(c.sse, "utf8");
    for (const size of [1, 2, 3, 7, 64, raw.length]) {
      const capture = new Capture();
      for (let i = 0; i < raw.length; i += size) capture.feed(raw.subarray(i, i + size));
      same(capture.message ?? null, c.message, `${c.name}/${size}`);
      expect(capture.complete, `${c.name}/${size}`).toBe(c.complete);
    }
  }
});

test("upstream proxy selection matches the recorded outputs", () => {
  for (const p of ref.proxies) {
    const got = upstreamProxy(new URL(p.url), p.env);
    same(got ? { host: got.host, port: got.port, headers: got.headers ?? null } : null, p.result, JSON.stringify(p));
  }
});

// `resets` drops that many connections before answering, as a flaky network path would.
async function peer(resets = 0): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const sse = ref.captures.find((c: { name: string }) => c.name === "text-unicode").sse;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (requests.length <= resets) { req.socket.destroy(); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "request-id": "req-fixture" });
      res.end(sse);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests };
}

const post = (url: string, body: unknown) => fetch(url + "/v1/messages",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("admission forwards exactly one request and captures its usage", async () => {
  const upstream = await peer();
  const gate = await Admission.open(upstream.url, 3000);
  try {
    const first = await post(gate.url, { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(first.status).toBe(200);
    await first.text();
    expect(gate.capture.complete).toBe(true);
    same(gate.capture.message!.content, [{ type: "text", text: "Hello λ🙂" }], "captured content");
    expect((gate.capture.message!.usage as { output_tokens: number }).output_tokens).toBe(9);
    expect(gate.requestId).toBe("req-fixture");
    const second = await post(gate.url, { messages: [] });
    expect(second.status).toBe(400);
    expect(await second.text()).toMatch(/LUNA_MODEL_ADMISSION_CONSUMED/);
    expect(gate.denied).toBe(1);
    expect(upstream.requests.length).toBe(1);
    const probe = await fetch(gate.url.replace(/\/admit\/.*/, "/api/hello"));
    expect(probe.status, "warm-up probes are refused quietly").toBe(404);
    await probe.text();
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test("admission retries a connection that drops before upstream answers", async () => {
  const flaky = await peer(1);
  const gate = await Admission.open(flaky.url, 3000);
  try {
    const response = await post(gate.url, { messages: [] });
    expect(response.status).toBe(200);
    await response.text();
    expect(gate.capture.complete).toBe(true);
    expect(flaky.requests.length).toBe(2);
    expect(gate.retries).toBe(1);
    expect(flaky.requests[1], "retry preserves the transformed request").toStrictEqual(flaky.requests[0]);
    expect(gate.failure).toBe(undefined);
  } finally {
    await gate.close();
    flaky.server.close();
  }

  const dead = await peer(Infinity);
  const failed = await Admission.open(dead.url, 3000);
  try {
    const response = await post(failed.url, { messages: [] });
    expect(response.status).toBe(502);
    await response.text();
    expect(dead.requests.length, "two retries, then the failure reaches native").toBe(3);
    expect(failed.failure ?? "", "the failure names the network error").toMatch(/^ECONNRESET \(socket hang up\)$/);
  } finally {
    await failed.close();
    dead.server.close();
  }
});

test("admission does not retry an HTTP error or an interrupted response", async () => {
  for (const status of [429, 200]) {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(status, { "content-type": "text/event-stream" });
      if (status === 429) res.end("rate limited");
      else res.write('data: {"type":"ping"}\n\n', () => res.destroy());
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const gate = await Admission.open(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 3000);
    try {
      if (status === 429) {
        const response = await post(gate.url, { messages: [] });
        expect(response.status).toBe(429);
        expect(await response.text()).toBe("rate limited");
      } else {
        await rejectsWith(async () => {
          const response = await post(gate.url, { messages: [] });
          await response.text();
        });
      }
      expect(gate.status).toBe(status);
      expect(gate.retries).toBe(0);
      expect(requests).toBe(1);
    } finally {
      await gate.close();
      server.close();
    }
  }
});

test("closing admission cancels a pending relay retry", async () => {
  const upstream = await peer(Infinity);
  const gate = await Admission.open(upstream.url, 3000);
  const response = post(gate.url, { messages: [] });
  // Attach rejection handling before close destroys the client's connection.
  const rejected = rejectsWith(response);
  try {
    const deadline = Date.now() + 3000;
    while (gate.retries === 0 && Date.now() < deadline) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(gate.retries).toBe(1);
    await gate.close();
    await rejected;
    expect(upstream.requests.length).toBe(1);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test("admission never forwards a synthetic tool result", async () => {
  const upstream = await peer();
  const host = [{ type: "tool_result", tool_use_id: "call-1", content: "actual-host-result", is_error: false }];
  const gate = await Admission.open(upstream.url, 3000, host);
  try {
    const response = await post(gate.url, { messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "mcp__luna__lookup", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "Permission denied", is_error: true }] },
    ] });
    expect(response.status).toBe(400);
    await response.text();
    expect(gate.failure).toBe("QueriedTurnMismatch");
    expect(gate.unrestored).toBeTruthy();
    expect(upstream.requests.length).toBe(0);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test("admission refuses non-HTTPS and credential-bearing upstreams", async () => {
  for (const url of ["http://api.anthropic.com", "https://user:pass@api.anthropic.com", "https://api.anthropic.com/?x=1"]) {
    await rejectsWith(Admission.open(url, 1000), /HTTPS or a loopback/, url);
  }
});
