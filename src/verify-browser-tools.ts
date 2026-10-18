// Deterministic test suite for native browser tools extension, configuration, settings, and Camofox MCP provider adapter.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { openLuna, context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { SettingsStore } from "./settings.js";
import { createBrowserToolsExtension, type BrowserProvider } from "./browser-tools.js";

const dir = mkdtempSync(join(tmpdir(), "luna-browser-tools-"));
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const fm = faux.getModel();
const model = { provider: fm.provider, modelId: fm.id };

async function invoke(harness: Awaited<ReturnType<typeof openLuna>>, tool: string, args: unknown) {
  let result: any;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool, args as any)], { stopReason: "toolUse" }),
    (c: any) => {
      result = c.messages.filter((m: any) => m.role === "toolResult").at(-1);
      return fauxAssistantMessage([fauxText("done")]);
    },
  ]);
  const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const agent = await conv.agent(context);
  assert.ok(agent.tools.some((t) => t.name === tool), `${tool} must be natively offered`);
  await (await conv.submit({ type: "input", content: "Run browser verification" }, context)).wait(context);
  assert.ok(result, `Missing result for ${tool}`);
  const text = typeof result.content === "string" ? result.content : result.content.map((c: any) => c.text ?? "").join("");
  const images = Array.isArray(result.content) ? result.content.filter((c: any) => c.type === "image") : [];
  return {
    error: result.isError === true,
    text,
    images,
    data: () => JSON.parse(text),
  };
}

const seen: { tool: string; args: any }[] = [];
const validPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const http = createServer(async (req, res) => {
  const server = new McpServer({ name: "camofox-fixture", version: "1.0.0" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  server.tool("camofox_create_tab", "open", { url: z.string() }, async (args) => {
    seen.push({ tool: "camofox_create_tab", args });
    if (args.url.includes("error")) return { content: [{ type: "text", text: "secret-token leak" }], isError: true };
    if (args.url.endsWith("/structured")) return { content: [], structuredContent: { tabId: "tab-1", url: args.url } };
    if (args.url.endsWith("/missing-tab")) return { content: [{ type: "text", text: JSON.stringify({ url: args.url }) }] };
    if (args.url.includes("malformed")) return { content: [{ type: "text", text: "not json" }] };
    return { content: [{ type: "text", text: JSON.stringify({ tabId: "tab-1", url: args.url }) }] };
  });

  server.tool("camofox_navigate", "navigate", { tabId: z.string(), url: z.string() }, async (args) => {
    seen.push({ tool: "camofox_navigate", args });
    if (args.url.includes("fail-nav")) {
      return { content: [{ type: "text", text: JSON.stringify({ tabId: args.tabId, url: args.url, navigationOk: false }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ tabId: args.tabId, url: args.url, navigationOk: true }) }] };
  });

  server.tool("camofox_close_tab", "close", { tabId: z.string() }, async (args) => {
    seen.push({ tool: "camofox_close_tab", args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  server.tool("camofox_snapshot", "snapshot", { tabId: z.string(), offset: z.number().optional() }, async (args) => {
    seen.push({ tool: "camofox_snapshot", args });
    if (args.tabId === "malformed") return { content: [{ type: "text", text: JSON.stringify({ url: "https://example.com", hasMore: false }) }] };
    if (args.tabId === "missing-page") return { content: [{ type: "text", text: JSON.stringify({ url: "https://example.com", snapshot: "bad", hasMore: true }) }] };
    if (args.tabId === "empty") return { content: [], structuredContent: { url: "https://example.com", snapshot: "", hasMore: false } };
    if (args.offset === 10) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ url: "https://example.com", snapshot: "page 2", hasMore: false }) },
          { type: "image", data: validPng, mimeType: "image/png" },
        ],
      };
    }
    if (args.offset === 99) {
      // Malformed pagination: hasMore true but non-increasing or missing nextOffset
      return {
        content: [{ type: "text", text: JSON.stringify({ url: "https://example.com", snapshot: "bad", hasMore: true, nextOffset: 5 }) }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ url: "https://example.com", snapshot: '- textbox "Name" [e1]' , hasMore: true, nextOffset: 10, totalChars: 20 }) }],
    };
  });

  server.tool("camofox_click", "click", { tabId: z.string(), ref: z.string().optional(), selector: z.string().optional() }, async (args) => {
    seen.push({ tool: "camofox_click", args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  server.tool("camofox_type", "type", { tabId: z.string(), ref: z.string().optional(), selector: z.string().optional(), text: z.string(), pressEnter: z.boolean().optional() }, async (args) => {
    seen.push({ tool: "camofox_type", args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  server.tool("camofox_scroll", "scroll", { tabId: z.string(), direction: z.string(), amount: z.number() }, async (args) => {
    seen.push({ tool: "camofox_scroll", args });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
  });

  server.tool("camofox_screenshot", "screenshot", { tabId: z.string() }, async (args) => {
    seen.push({ tool: "camofox_screenshot", args });
    if (args.tabId === "bad-shot") {
      return { content: [{ type: "text", text: "invalid-shot" }] };
    }
    if (args.tabId === "invalid-image") return { content: [{ type: "image", data: "not-an-image", mimeType: "image/png" }] };
    if (args.tabId === "wrong-mime") return { content: [{ type: "image", data: validPng, mimeType: "image/svg+xml" }] };
    return {
      content: [
        { type: "text", text: JSON.stringify({ tabId: args.tabId }) },
        { type: "image", data: validPng, mimeType: "image/png" },
      ],
    };
  });

  await server.connect(transport);
  await transport.handleRequest(req, res);
});

await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;

try {
  // 1. Config validation
  assert.throws(() => parseConfig({ browser: { provider: "unknown" } }, dir, {}), /browser.provider/);
  assert.throws(() => parseConfig({ browser: { providers: { camofox: { unknownField: true } } } }, dir, {}), /Unrecognized/);

  const cfg = parseConfig(
    {
      dataDir: dir,
      extensions: [],
      browser: {
        provider: "camofox",
        providers: { camofox: { mcpServer: "camofox-server" } },
      },
      mcpServers: [{ name: "camofox-server", transport: "http", url }],
    },
    dir,
    {}
  );

  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  try {
    // browser_open
    let resOpen = await invoke(rt.harness, "browser_open", { url: "https://example.com" });
    assert.equal(resOpen.error, false, resOpen.text);
    assert.deepEqual(resOpen.data(), { tabId: "tab-1", url: "https://example.com" });
    assert.equal(seen.at(-1)?.tool, "camofox_create_tab");
    for (const path of ["structured"]) {
      const result = await invoke(rt.harness, "browser_open", { url: "https://example.com/" + path });
      assert.equal(result.error, false, result.text); assert.equal(result.data().tabId, "tab-1");
    }
    for (const path of ["malformed", "missing-tab"]) assert.equal((await invoke(rt.harness, "browser_open", { url: "https://example.com/" + path })).error, true);


    // browser_navigate (success & navigationOk: false)
    let resNav = await invoke(rt.harness, "browser_navigate", { tabId: "tab-1", url: "https://example.com/other" });
    assert.equal(resNav.error, false, resNav.text);

    let resNavFail = await invoke(rt.harness, "browser_navigate", { tabId: "tab-1", url: "https://example.com/fail-nav" });
    assert.equal(resNavFail.error, true);

    // browser_snapshot with pagination & non-increasing pagination validation failure
    let resSnap1 = await invoke(rt.harness, "browser_snapshot", { tabId: "tab-1" });
    assert.equal(resSnap1.error, false, resSnap1.text);
    assert.equal(resSnap1.data().hasMore, true);
    assert.equal(resSnap1.data().nextOffset, 10);
    assert.equal(resSnap1.data().content, '- textbox "Name" [e1]');
    const nextPage = await invoke(rt.harness, "browser_snapshot", { tabId: "tab-1", offset: 10 });
    assert.equal(nextPage.error, false, nextPage.text); assert.equal(nextPage.data().content, "page 2");
    assert.equal(nextPage.images[0].data, validPng); assert.ok(!nextPage.text.includes(validPng));
    assert.deepEqual(seen.at(-1), { tool: "camofox_snapshot", args: { tabId: "tab-1", offset: 10 } });
    const empty = await invoke(rt.harness, "browser_snapshot", { tabId: "empty" });
    assert.equal(empty.error, false, empty.text); assert.equal(empty.data().content, "");
    for (const id of ["malformed", "missing-page"]) assert.equal((await invoke(rt.harness, "browser_snapshot", { tabId: id })).error, true);


    let resSnapBadPag = await invoke(rt.harness, "browser_snapshot", { tabId: "tab-1", offset: 99 });
    assert.equal(resSnapBadPag.error, true);

    // browser_click & browser_type & browser_scroll
    let resClick = await invoke(rt.harness, "browser_click", { tabId: "tab-1", ref: "e1" });
    assert.equal(resClick.error, false, resClick.text);
    assert.deepEqual(resClick.data(), { tabId: "tab-1", ok: true });
    assert.deepEqual(seen.at(-1), { tool: "camofox_click", args: { tabId: "tab-1", ref: "e1" } });

    let resType = await invoke(rt.harness, "browser_type", { tabId: "tab-1", selector: "input", text: "hello", pressEnter: true });
    assert.equal(resType.error, false, resType.text);
    assert.deepEqual(seen.at(-1), { tool: "camofox_type", args: { tabId: "tab-1", selector: "input", text: "hello", pressEnter: true } });

    let resScroll = await invoke(rt.harness, "browser_scroll", { tabId: "tab-1", direction: "down", amount: 300 });
    assert.equal(resScroll.error, false, resScroll.text);
    await invoke(rt.harness, "browser_scroll", { tabId: "tab-1", direction: "up" });
    assert.deepEqual(seen.at(-1), { tool: "camofox_scroll", args: { tabId: "tab-1", direction: "up", amount: 500 } });


    // browser_screenshot & screenshot failure cases
    let resShot = await invoke(rt.harness, "browser_screenshot", { tabId: "tab-1" });
    assert.equal(resShot.error, false, resShot.text);
    assert.equal(resShot.images.length, 1);
    assert.equal(resShot.images[0].data, validPng); assert.ok(!resShot.text.includes(validPng));

    let resShotBad = await invoke(rt.harness, "browser_screenshot", { tabId: "bad-shot" });
    assert.equal(resShotBad.error, true);
    for (const id of ["invalid-image", "wrong-mime"]) assert.equal((await invoke(rt.harness, "browser_screenshot", { tabId: id })).error, true);
    const closed = await invoke(rt.harness, "browser_close", { tabId: "tab-1" });
    assert.equal(closed.error, false, closed.text); assert.deepEqual(closed.data(), { tabId: "tab-1", closed: true });
    assert.deepEqual(seen.at(-1), { tool: "camofox_close_tab", args: { tabId: "tab-1" } });


    // Schema validation errors & unsafe inputs (rejected arguments never reach provider)
    const callsBefore = seen.length;
    let resBadUrl = await invoke(rt.harness, "browser_open", { url: "javascript:alert(1)" });
    assert.equal(resBadUrl.error, true);

    let resBadTarget = await invoke(rt.harness, "browser_click", { tabId: "tab-1" }); // neither ref nor selector
    assert.equal(resBadTarget.error, true);
    for (const [tool, args] of [
      ["browser_open", { url: "file:///etc/passwd" }], ["browser_open", { url: "https://user:password@example.com" }],
      ["browser_open", { url: "https://example.com", backend: "camofox" }],
      ["browser_navigate", { tabId: "tab-1", url: "javascript:alert(1)" }],
      ["browser_navigate", { tabId: "tab-1", url: "https://example.com", macro: "@google_search" }],
      ["browser_click", { tabId: "tab-1", ref: "e1", selector: "button" }],
      ["browser_click", { tabId: "tab-1", ref: " " }], ["browser_type", { tabId: "tab-1", selector: " " , text: "x" }],
      ["browser_type", { tabId: "tab-1", ref: "e1" }],
      ["browser_close", { tabId: "../sessions" }], ["browser_screenshot", { tabId: "tab?userId=other" }],
      ["browser_snapshot", { tabId: "%2e%2e%2fother" }],
      ["browser_close", { tabId: " " }], ["browser_snapshot", { tabId: "tab-1", offset: -1 }],
      ["browser_snapshot", { tabId: "tab-1", offset: 0.5 }], ["browser_scroll", { tabId: "tab-1", direction: "diagonal" }],
      ["browser_scroll", { tabId: "tab-1", direction: "down", amount: 0 }],
      ["browser_scroll", { tabId: "tab-1", direction: "down", amount: 1.5 }],
    ] as const) assert.equal((await invoke(rt.harness, tool, args)).error, true, `${tool} ${JSON.stringify(args)}`);
    assert.equal(seen.length, callsBefore, "Rejected arguments must not call provider");

    let resErrorLeak = await invoke(rt.harness, "browser_open", { url: "https://example.com/error" });
    assert.equal(resErrorLeak.error, true);
    assert.ok(!resErrorLeak.text.includes("secret-token"));

    console.log("OK camofox adapter and runtime browser tools integration");
  } finally {
    await rt.close();
  }

  // 4. Durable cancellation forwarding to provider & unanswered result observation
  let started!: () => void, cancelled!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  const waitingProvider: BrowserProvider = {
    async open(_req, signal) {
      started();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => { cancelled(); reject(signal.reason); };
        if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      });
      return { tabId: "w1", url: "https://example.com" };
    },
    async navigate(req) { return req; },
    async close() {},
    async snapshot() { return { tabId: "w1", url: "https://example.com", content: "", hasMore: false }; },
    async click() {},
    async type() {},
    async scroll() {},
    async screenshot() { return { data: validPng, mimeType: "image/png" }; },
  };

  const abortHarness = await openLuna({
    dbPath: join(dir, "abort.db"),
    models,
    coding: false,
    memory: false,
    extensions: [createBrowserToolsExtension({ provider: "waiting" }, new Map([["waiting", waitingProvider]]))],
  });
  try {
    faux.setResponses([fauxAssistantMessage([fauxToolCall("browser_open", { url: "https://example.com" })], { stopReason: "toolUse" })]);
    const conv = await abortHarness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const submission = await conv.submit({ type: "input", content: "cancel test" }, context);
    await start;
    await conv.abort(context);
    await cancellation;
    const subResult = await submission.wait(context);
    assert.equal(subResult.status, "unanswered");
  } finally {
    await abortHarness.close(context);
  }
  console.log("OK durable cancellation reaches provider and yields unanswered status");

  // 5. Routing A/B between providers through browser tools extension
  const makeProv = (name: string): BrowserProvider => ({
    async open(req) { return { tabId: `${name}-1`, url: req.url }; },
    async navigate(req) { return req; },
    async close() {},
    async snapshot() { return { tabId: "t1", url: "https://example.com", content: name, hasMore: false }; },
    async click() {},
    async type() {},
    async scroll() {},
    async screenshot() { return { data: validPng, mimeType: "image/png" }; },
  });

  for (const provName of ["alpha", "beta"]) {
    const harness = await openLuna({
      dbPath: join(dir, `${provName}.db`),
      models,
      coding: false,
      memory: false,
      extensions: [createBrowserToolsExtension({ provider: provName }, new Map([["alpha", makeProv("alpha")], ["beta", makeProv("beta")]]))],
    });
    try {
      const res = await invoke(harness, "browser_open", { url: "https://example.com" });
      assert.equal(res.error, false);
      assert.equal(res.data().tabId, `${provName}-1`);
    } finally {
      await harness.close(context);
    }
  }

  // Disabled or missing provider
  for (const disabledProvider of ["disabled", "nonexistent"]) {
    const harness = await openLuna({
      dbPath: join(dir, `${disabledProvider}.db`),
      models,
      coding: false,
      memory: false,
      extensions: [createBrowserToolsExtension({ provider: disabledProvider }, new Map([["alpha", makeProv("alpha")]]))],
    });
    try {
      const res = await invoke(harness, "browser_open", { url: "https://example.com" });
      assert.equal(res.error, true);
    } finally {
      await harness.close(context);
    }
  }

  // 6. Settings Store persistence & restart required
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ dataDir: join(dir, "sdata"), providers: [] }));
  const store = new SettingsStore(settingsPath, join(dir, "sdata"));
  const view = store.view();
  view.config.browser.provider = "camofox";
  store.replace(view.config, view.revision);
  assert.equal(store.restartRequired, true);
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).browser.provider, "camofox");

  console.log("VERIFY_BROWSER_TOOLS_OK");
} finally {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
}
