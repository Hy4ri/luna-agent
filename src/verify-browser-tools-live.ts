// Real Camofox MCP + browser, through the actual runtime's native tools. No model inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { loadConfig, parseConfig } from "./config.js";
import { startRuntime, type Runtime } from "./runtime.js";

const dir = mkdtempSync(join(tmpdir(), "luna-browser-live-"));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(); const model = { provider: fm.provider, modelId: fm.id };
const page = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(req.url === "/next" ? '<!doctype html><html><body><h1>Browser next page</h1><a href="/">Return</a></body></html>' : `<!doctype html><html><body><h1>Native browser fixture</h1>
    <label>Name<input id="name" aria-label="Name"></label><button id="apply" onclick="document.getElementById('result').textContent='Hello '+document.getElementById('name').value">Apply</button>
    <p id="result">Not applied</p><a href="/next">Next page</a><div style="height:2000px"></div><p>Bottom marker</p></body></html>`);
});
let rt: Runtime | undefined, tabId: string | undefined, closed = false;
await new Promise<void>(resolve => page.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(page.address() as { port: number }).port}`;
try {
  const cfg = loadConfig();
  const mcpName = cfg.browser.providers.camofox.mcpServer;
  const server = cfg.mcpServers.find(s => s.name === mcpName);
  if (!server || server.transport !== "stdio") throw new Error(`Live gate requires a configured stdio Camofox MCP connection named "${mcpName}" to isolate the browser session.`);
  const session = `luna-verify-${randomUUID()}`;
  rt = await startRuntime(parseConfig({ dataDir: dir, extensions: [], browser: { provider: "camofox", providers: { camofox: { mcpServer: mcpName } } },
    mcpServers: [{ ...server, enabled: true, env: { ...server.env, CAMOFOX_USER_ID: session, CAMOFOX_SESSION_KEY: session } }],
  }, dir, {}), { models, model });
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  const names = (await conv.agent(context)).tools.map(t => t.name);
  for (const tool of ["browser_open", "browser_navigate", "browser_close", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_screenshot"]) assert.ok(names.includes(tool), `${tool} must be natively offered`);
  async function invoke(tool: string, args: Parameters<typeof fauxToolCall>[1]) {
    let result: any;
    faux.setResponses([fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" }), (c: any) => {
      result = c.messages.filter((m: any) => m.role === "toolResult").at(-1); return fauxAssistantMessage("done");
    }]);
    assert.equal((await (await conv.submit({ type: "input", content: "Verify browser tool" }, context)).wait(context)).status, "done");
    assert.ok(result, `Missing tool result: ${tool}`);
    const text = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    assert.equal(result.isError === true, false, `${tool}: ${text}`);
    return { data: JSON.parse(text), content: result.content };
  }
  try {
    const opened = await invoke("browser_open", { url: base }); tabId = opened.data.tabId;
    assert.ok(tabId); assert.equal(opened.data.url, base + "/");
    let snapshot = await invoke("browser_snapshot", { tabId }); assert.match(snapshot.data.content, /Native browser fixture/);
    const nameRef = /textbox "Name" \[(e\d+)\]/.exec(snapshot.data.content)?.[1];
    const applyRef = /button "Apply" \[(e\d+)\]/.exec(snapshot.data.content)?.[1];
    assert.ok(nameRef, snapshot.data.content); assert.ok(applyRef, snapshot.data.content);
    await invoke("browser_type", { tabId, ref: nameRef, text: "Luna native" });
    // Refresh refs after input changes, then click the new button ref.
    snapshot = await invoke("browser_snapshot", { tabId });
    const freshApplyRef = /button "Apply" \[(e\d+)\]/.exec(snapshot.data.content)?.[1]; assert.ok(freshApplyRef);
    await invoke("browser_click", { tabId, ref: freshApplyRef });
    snapshot = await invoke("browser_snapshot", { tabId }); assert.match(snapshot.data.content, /Hello Luna native/);
    await invoke("browser_type", { tabId, selector: "#name", text: "Selector route", pressEnter: false });
    await invoke("browser_click", { tabId, selector: "#apply" });
    snapshot = await invoke("browser_snapshot", { tabId }); assert.match(snapshot.data.content, /Hello Selector route/);
    const before = await invoke("browser_screenshot", { tabId });
    await invoke("browser_scroll", { tabId, direction: "down", amount: 700 });
    const after = await invoke("browser_screenshot", { tabId });
    const firstImage = before.content.find((c: any) => c.type === "image"), lastImage = after.content.find((c: any) => c.type === "image");
    assert.ok(firstImage?.data && lastImage?.data, "Screenshots must reach the tool transcript as images");
    assert.notEqual(lastImage.data, firstImage.data, "Scroll must change the actual viewport");
    assert.ok(Buffer.from(lastImage.data, "base64").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    writeFileSync("/tmp/luna17-browser-live.png", Buffer.from(firstImage.data, "base64"));
    writeFileSync("/tmp/luna17-browser-scrolled.png", Buffer.from(lastImage.data, "base64"));
    const nav = await invoke("browser_navigate", { tabId, url: base + "/next" }); assert.equal(nav.data.url, base + "/next");
    snapshot = await invoke("browser_snapshot", { tabId }); assert.match(snapshot.data.content, /Browser next page/);
    await invoke("browser_close", { tabId }); closed = true;
    // A real post-close error proves close had an effect, rather than only returning success.
    const probe: any = await rt.mcp.callTool(mcpName, "camofox_snapshot", { tabId }, AbortSignal.timeout(10000));
    assert.equal(probe.isError, true, "Closed tab must no longer accept snapshots");
    console.log("BROWSER_TOOLS_LIVE_OK: native runtime, real Camofox open/snapshot/refs/type/click/selectors/scroll/image delivery/navigation/close");
  } finally {
    if (tabId && !closed) await rt.mcp.callTool(mcpName, "camofox_close_tab", { tabId }, AbortSignal.timeout(10000)).catch(() => {});
  }
} finally {
  await rt?.close(); await new Promise<void>(resolve => page.close(() => resolve())); rmSync(dir, { recursive: true, force: true });
}
