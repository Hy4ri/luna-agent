// Contract: the native Claude transport keeps the prompt-cache prefix byte-stable and admits one native request with bounded network retries.
// fixtures/claude-native-python-parity.json holds outputs captured from the retired Python DirectSDK transport.
// A change here moves the cache prefix of every existing conversation, so a diff must be deliberate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { Admission, Capture, QueriedTurnMismatch, pinMessageBreakpoint, restoreQueriedTurn,
  stableRequestContext, upstreamProxy } from "../src/claude-native/admission.js";
import { CARRIER_TYPE, TOOL_PREFIX, buildBody, conversationSessionId, conversationToolPrefix, deepEqual, nativeModel,
  prepareHistory } from "../src/claude-native/history.js";

const ref = JSON.parse(readFileSync(new URL("./fixtures/claude-native-python-parity.json", import.meta.url), "utf8"));
const same = (actual: unknown, expected: unknown, message: string) =>
  assert.ok(deepEqual(actual, expected), `${message}\n got: ${JSON.stringify(actual)}\nwant: ${JSON.stringify(expected)}`);

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
        assert.ok(error instanceof QueriedTurnMismatch, `${c.name}/${name}: ${error}`);
        got = { throws: true };
      }
      same(got, c.python[name], `${c.name}/${name}`);
    }
  }
});

test("history frames and session ids match the recorded outputs and do not mutate input", () => {
  for (const h of ref.histories) {
    const input = structuredClone(h.input);
    const { system, frames } = prepareHistory(input, new Map([["lookup", "lookup"]]));
    assert.equal(system, h.system);
    same(frames, h.frames, "frames");
    same(input, h.input, "input must not be mutated");
    assert.equal(conversationSessionId(system, frames), h.session, "a changed id moves the cache prefix");
  }
});

test("model routes match the recorded outputs", () => {
  for (const [model, want] of Object.entries(ref.models)) {
    if (want === "THROWS") assert.throws(() => nativeModel(model), /1M/, model);
    else assert.equal(nativeModel(model), want, model);
  }
});

// The recording predates the rename to mcp__luna__ (#203). Conversations started before it keep the legacy
// prefix, because signed tool-use blocks cannot be renamed, so the recording proves the legacy path byte for byte.
const LEGACY_PREFIX = "mcp__hermes__";

test("request body matches the recorded output and rejects invalid tools", () => {
  const built = buildBody(ref.body.request, LEGACY_PREFIX);
  assert.equal(built.body, ref.body.body);
  same(built.manifest, ref.body.manifest, "manifest");
  same(Object.fromEntries(built.names), ref.body.names, "names");
  const tool = (name: string) => ({ type: "function" as const, function: { name, description: "", parameters: { type: "object" } } });
  assert.throws(() => buildBody({ model: "m", messages: [], stream: true, tools: [tool("a"), tool("a")] }), /unique/);
  assert.throws(() => buildBody({ model: "m", messages: [], stream: true, tools: [tool("bad name")] }), /ASCII identifiers/);
  assert.throws(() => buildBody({ model: "m", messages: [], stream: true, tools: [], max_tokens: 0 }), /positive/);
});

test("new conversations use the Luna prefix and carriers keep their recorded prefix", () => {
  assert.equal(TOOL_PREFIX, "mcp__luna__");
  const fresh = buildBody(ref.body.request).body;
  assert.equal(fresh, (buildBody(ref.body.request, LEGACY_PREFIX).body as string).replaceAll(LEGACY_PREFIX, TOOL_PREFIX));
  const carrier = (detail: Record<string, unknown>) => [{ role: "assistant" as const, content: "", reasoning_details: [{ type: CARRIER_TYPE, ...detail }] }];
  assert.equal(conversationToolPrefix([]), TOOL_PREFIX);
  assert.equal(conversationToolPrefix(carrier({ wirePrefix: LEGACY_PREFIX })), LEGACY_PREFIX);
  // Older carriers have no marker; the prefix comes from their signed tool-use names.
  assert.equal(conversationToolPrefix(carrier({ messages: [{ content: [{ type: "tool_use", name: "mcp__hermes__lookup" }] }] })), LEGACY_PREFIX);
  assert.throws(() => conversationToolPrefix([...carrier({ wirePrefix: LEGACY_PREFIX }), ...carrier({ wirePrefix: TOOL_PREFIX })]), /Conflicting/);
  assert.throws(() => conversationToolPrefix(carrier({ wirePrefix: "evil" })), /Unsupported/);
});

test("SSE capture is independent of chunk boundaries, including split UTF-8", () => {
  for (const c of ref.captures) {
    const raw = Buffer.from(c.sse, "utf8");
    for (const size of [1, 2, 3, 7, 64, raw.length]) {
      const capture = new Capture();
      for (let i = 0; i < raw.length; i += size) capture.feed(raw.subarray(i, i + size));
      same(capture.message ?? null, c.message, `${c.name}/${size}`);
      assert.equal(capture.complete, c.complete, `${c.name}/${size}`);
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
    assert.equal(first.status, 200);
    await first.text();
    assert.equal(gate.capture.complete, true);
    same(gate.capture.message!.content, [{ type: "text", text: "Hello λ🙂" }], "captured content");
    assert.equal((gate.capture.message!.usage as { output_tokens: number }).output_tokens, 9);
    assert.equal(gate.requestId, "req-fixture");
    const second = await post(gate.url, { messages: [] });
    assert.equal(second.status, 400);
    assert.match(await second.text(), /LUNA_MODEL_ADMISSION_CONSUMED/);
    assert.equal(gate.denied, 1);
    assert.equal(upstream.requests.length, 1);
    const probe = await fetch(gate.url.replace(/\/admit\/.*/, "/api/hello"));
    assert.equal(probe.status, 404, "warm-up probes are refused quietly");
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
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(gate.capture.complete, true);
    assert.equal(flaky.requests.length, 2);
    assert.equal(gate.retries, 1);
    assert.deepEqual(flaky.requests[1], flaky.requests[0], "retry preserves the transformed request");
    assert.equal(gate.failure, undefined);
  } finally {
    await gate.close();
    flaky.server.close();
  }

  const dead = await peer(Infinity);
  const failed = await Admission.open(dead.url, 3000);
  try {
    const response = await post(failed.url, { messages: [] });
    assert.equal(response.status, 502);
    await response.text();
    assert.equal(dead.requests.length, 3, "two retries, then the failure reaches native");
    assert.match(failed.failure ?? "", /^ECONNRESET \(socket hang up\)$/, "the failure names the network error");
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
        assert.equal(response.status, 429);
        assert.equal(await response.text(), "rate limited");
      } else {
        await assert.rejects(async () => {
          const response = await post(gate.url, { messages: [] });
          await response.text();
        });
      }
      assert.equal(gate.status, status);
      assert.equal(gate.retries, 0);
      assert.equal(requests, 1);
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
  const rejected = assert.rejects(response);
  try {
    const deadline = Date.now() + 3000;
    while (gate.retries === 0 && Date.now() < deadline) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal(gate.retries, 1);
    await gate.close();
    await rejected;
    assert.equal(upstream.requests.length, 1);
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
    assert.equal(response.status, 400);
    await response.text();
    assert.equal(gate.failure, "QueriedTurnMismatch");
    assert.ok(gate.unrestored);
    assert.equal(upstream.requests.length, 0);
  } finally {
    await gate.close();
    upstream.server.close();
  }
});

test("admission refuses non-HTTPS and credential-bearing upstreams", async () => {
  for (const url of ["http://api.anthropic.com", "https://user:pass@api.anthropic.com", "https://api.anthropic.com/?x=1"]) {
    await assert.rejects(Admission.open(url, 1000), /HTTPS or a loopback/, url);
  }
});
