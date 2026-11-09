// Contract: a stdio MCP server receives a minimal environment plus its own `env`, never the daemon's secrets,
// and its tools are deferred by default so every model call does not carry every MCP schema.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterAll as after, beforeAll as before, test } from "bun:test";
import { connectMcpServer, type McpConnection } from "../src/mcp.js";

const SECRETS = { LUNA_TOKEN: "luna-secret", ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-secret" };
const saved = Object.fromEntries(Object.keys(SECRETS).map(k => [k, process.env[k]]));
let connection: McpConnection;

before(async () => {
  Object.assign(process.env, SECRETS);
  connection = await connectMcpServer({
    name: "env test", transport: "stdio", command: process.execPath,
    args: [fileURLToPath(new URL("./support/env-mcp-server.mjs", import.meta.url))], env: { ONLY_MINE: "1" },
  });
});
after(async () => {
  await connection?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("stdio child environment excludes daemon secrets and includes the configured env", async () => {
  const result = await connection.callTool("env", {}, AbortSignal.timeout(10_000)) as { content: { text: string }[] };
  const env = JSON.parse(result.content[0]!.text) as Record<string, string>;
  for (const key of Object.keys(SECRETS)) assert.equal(env[key], undefined, `${key} leaked to the MCP child`);
  assert.equal(env.ONLY_MINE, "1");
  assert.ok(env.PATH, "PATH is part of the minimal environment");
});

test("tools are namespaced by a sanitized server name and deferred by default", () => {
  assert.deepEqual(connection.toolNames, ["env_test__env"]);
  const tools = (connection.extension as unknown as { tools: { name: string; deferred?: boolean }[] }).tools;
  assert.deepEqual(tools.map(t => [t.name, t.deferred]), [["env_test__env", true]]);
});

test("a provider-backend server stays connected but its tools leave the registry, and come back when the provider changes", async () => {
  const { createRegistry } = await import("@earendil-works/pi-durable");
  const { McpManager, providerBackedServers } = await import("../src/mcp.js");
  const { parseConfig } = await import("../src/config.js");
  const installed: string[] = [];
  const base = createRegistry();
  const registry = { ...base, install: (e: { name: string }) => { installed.push(e.name); }, uninstall: (e: { name: string }) => { installed.splice(installed.indexOf(e.name), 1); } } as unknown as typeof base;
  const server = { name: "ddgs", transport: "stdio" as const, command: process.execPath,
    args: [fileURLToPath(new URL("./support/env-mcp-server.mjs", import.meta.url))] };
  let cfg = parseConfig({ web: { extractProvider: "ddgs" } });
  assert.deepEqual([...providerBackedServers(cfg)], ["ddgs"]);
  const mcp = new McpManager(registry, [server], undefined, undefined, () => providerBackedServers(cfg));
  try {
    await mcp.start();
    assert.equal(mcp.connections.length, 1, "backend server is connected");
    assert.deepEqual(installed, [], "backend tools are not installed");
    assert.equal(mcp.list()[0]!.backend, true);
    cfg = parseConfig({ web: { searchProvider: "searxng", searchFallbacks: [], extractProvider: "disabled" } });
    assert.deepEqual([...providerBackedServers(cfg)], []);
    mcp.syncExposure();
    assert.deepEqual(installed, ["mcp-ddgs"]);
    assert.equal(mcp.list()[0]!.backend, false);
  } finally { await mcp.close(); }
});
