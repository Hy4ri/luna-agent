// Verifies runtime MCP management through the HTTP API the web UI uses: add (connects first, saves only on
// success), list (secrets never returned), disable/enable, remove, config-file servers read-only, persistence.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vmcp-"));
let seenAuth = "";
const http = createServer(async (req, res) => {
  if (new URL(req.url ?? "/", "http://x").pathname !== "/mcp") return void res.writeHead(404).end();
  seenAuth = String(req.headers.authorization ?? "");
  const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { void t.close(); });
  const s = new McpServer({ name: "demo", version: "1.0.0" });
  s.tool("add", "Add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  await s.connect(t);
  await t.handleRequest(req, res);
});
await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp`;

try {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const fm = faux.getModel();
  const model = { provider: fm.provider, modelId: fm.id };
  const cfg = parseConfig({ dataDir: join(d, "data"), extensions: ["tool-search"], mcpServers: [{ name: "fixed", transport: "http", url }] }, d, {});
  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  const app = createApp({ harness: rt.harness, token: "tok", agent: { model }, models: rt.models, mcp: rt.mcp });
  const call = (path: string, method = "GET", body?: unknown) =>
    app.request(path, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const toolNames = async () => { const root = await rt.harness.root(context, { agent: { model } }); const a = await root.agent(context); return [...a.tools, ...a.deferred].map((t) => t.name); };

  let r = await call("/v1/mcp");
  let list = (await r.json() as any).servers;
  assert.equal(list.length, 1);
  assert.equal(list[0].source, "config");
  assert.equal(list[0].status, "connected");
  ok("config-file server listed as connected");

  // add: validated, connected, saved; secret values never returned
  r = await call("/v1/mcp", "POST", { name: "extra", transport: "http", url: url + "?k=hidden", headers: { Authorization: "Bearer sekrit" } });
  assert.equal(r.status, 201, await r.clone().text());
  const added = await r.json() as any;
  assert.equal(added.status, "connected");
  assert.deepEqual(added.tools, ["extra__add"]);
  assert.equal(seenAuth, "Bearer sekrit");
  assert.ok(!JSON.stringify(added).includes("sekrit") && !JSON.stringify(added).includes("hidden"), "secrets leaked");
  assert.deepEqual(added.secretKeys, ["Authorization"]);
  assert.ok(!(await (await call("/v1/mcp")).text()).includes("sekrit"));
  assert.ok((await toolNames()).includes("extra__add"), "tool not in registry");
  assert.equal(statSync(join(cfg.dataDir, "mcp.json")).mode & 0o777, 0o600);
  ok("add: connected live, tools registered, secrets hidden, mcp.json is 0600");

  // failures are reported and not saved
  r = await call("/v1/mcp", "POST", { name: "dead", transport: "http", url: "http://127.0.0.1:1/mcp" });
  assert.equal(r.status, 400);
  assert.ok(!readFileSync(join(cfg.dataDir, "mcp.json"), "utf8").includes("dead"));
  r = await call("/v1/mcp", "POST", { name: "bad name!", transport: "http", url });
  assert.equal(r.status, 400);
  r = await call("/v1/mcp", "POST", { name: "extra", transport: "http", url });
  assert.equal(r.status, 400, "duplicate name");
  r = await call("/v1/mcp", "POST", { name: "x", transport: "stdio", command: "x", shell: true });
  assert.equal(r.status, 400, "unknown key");
  ok("unreachable, invalid, duplicate and unknown-key servers rejected, nothing saved");

  // config servers are read-only
  assert.equal((await call("/v1/mcp/fixed", "DELETE")).status, 400);
  assert.equal((await call("/v1/mcp/fixed", "PATCH", { enabled: false })).status, 400);
  assert.equal((await call("/v1/mcp/extra", "PATCH", {})).status, 400);
  ok("config-file servers cannot be changed from the UI");

  // disable / enable
  r = await call("/v1/mcp/extra", "PATCH", { enabled: false });
  assert.equal(((await r.json()) as any).status, "disabled");
  assert.ok(!(await toolNames()).includes("extra__add"), "tool should be gone");
  r = await call("/v1/mcp/extra", "PATCH", { enabled: true });
  assert.equal(((await r.json()) as any).status, "connected");
  assert.ok((await toolNames()).includes("extra__add"));
  ok("disable removes the tools, enable reconnects");

  // persistence across restart
  await rt.close();
  const rt2 = await startRuntime(cfg, { models, model, log: () => {} });
  assert.deepEqual(rt2.mcp.list().map((s) => [s.name, s.status]), [["fixed", "connected"], ["extra", "connected"]]);
  ok("web-added servers reconnect after restart");

  const app2 = createApp({ harness: rt2.harness, token: "tok", agent: { model }, mcp: rt2.mcp });
  const del = await app2.request("/v1/mcp/extra", { method: "DELETE", headers: { authorization: "Bearer tok" } });
  assert.equal(del.status, 200);
  assert.deepEqual(rt2.mcp.list().map((s) => s.name), ["fixed"]);
  assert.ok(!readFileSync(join(cfg.dataDir, "mcp.json"), "utf8").includes("extra"));
  ok("remove disconnects and deletes it from mcp.json");
  await rt2.close();
  console.log("MCP_MANAGE_OK");
} finally {
  http.close();
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
