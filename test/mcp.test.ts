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
