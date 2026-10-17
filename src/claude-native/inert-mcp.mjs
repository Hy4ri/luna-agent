// Inventory only: no host imports, effects, or executable tool implementations. Luna executes every tool.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const row = JSON.parse(line);
  let result = {};
  if (row.method === "initialize") {
    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hermes-inert-inventory", version: "1" } };
  } else if (row.method === "tools/list") {
    result = { tools: manifest };
  } else if (row.method === "tools/call") {
    result = { isError: true, content: [{ type: "text", text: "Denied: native tools are inert; only Hermes executes tools." }] };
  }
  if ("id" in row) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: row.id, result }) + "\n");
}
