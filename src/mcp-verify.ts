// Verifies the MCP bridge against a real stdio server and a real SSE server (both built with the MCP SDK).
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { createRegistry } from "@earendil-works/pi-durable";
import { installMcpServers } from "./mcp.js";

function buildServer() {
  const s = new McpServer({ name: "demo", version: "1.0.0" });
  s.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  s.tool("boom", "Always errors", {}, async () => ({ isError: true, content: [{ type: "text", text: "kaboom" }] }));
  return s;
}

if (process.argv[2] === "server") {
  await buildServer().connect(new StdioServerTransport());
} else {
  const transports = new Map<string, SSEServerTransport>();
  const http = createServer(async (req, res) => {
    if (req.url === "/sse") {
      const t = new SSEServerTransport("/messages", res);
      transports.set(t.sessionId, t);
      await buildServer().connect(t);
    } else if (req.url?.startsWith("/messages")) {
      const id = new URL(req.url, "http://x").searchParams.get("sessionId")!;
      await transports.get(id)!.handlePostMessage(req, res);
    } else { res.writeHead(404).end(); }
  }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as any).port;

  const registry = createRegistry();
  const { connections, failures, close } = await installMcpServers(registry, [
    { name: "local", transport: "stdio", command: process.execPath, args: ["--import", "tsx", "src/mcp-verify.ts", "server"] },
    { name: "remote", transport: "sse", url: `http://127.0.0.1:${port}/sse` },
    { name: "bad", transport: "stdio", command: "/nonexistent-binary" },
  ]);
  const fail = (m: string): never => { console.error("FAIL", m); process.exit(1); };
  const names: string[] = registry.snapshot().tools().map((t: any) => t.tool.name as string).sort();
  console.log("registered:", names.join(", "));
  const want = ["local__add", "local__boom", "remote__add", "remote__boom"];
  if (JSON.stringify(names) !== JSON.stringify(want)) fail("tool set mismatch");
  if (failures.length !== 1 || failures[0]?.name !== "bad") fail("expected only 'bad' to fail: " + JSON.stringify(failures));
  console.log("OK bad server isolated:", (failures[0]?.error ?? "").slice(0, 80));
  for (const p of ["local", "remote"]) {
    const tool: any = registry.snapshot().tools().find((t: any) => t.tool.name === `${p}__add`)!.tool;
    const r = await tool.execute({ a: 2, b: 40 }, {}, {});
    if (r.output[0].text !== "42" || r.isError) fail(p + " add: " + JSON.stringify(r));
    const e: any = registry.snapshot().tools().find((t: any) => t.tool.name === `${p}__boom`)!.tool;
    const er = await e.execute({}, {}, {});
    if (!er.isError || er.output[0].text !== "kaboom") fail(p + " boom: " + JSON.stringify(er));
    console.log(`OK ${p}: add=42, error propagated`);
  }
  await close();
  http.closeAllConnections(); http.close();
  console.log("MCP_OK");
  process.exit(0);
}
