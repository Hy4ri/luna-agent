import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";
import { filterSlashCommands } from "../web/src/components/composer/commands.js";

test("/tools slash command lists active tools for the session and validates usage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-tools-cmd-"));
  const models = createModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: true });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    const agent = await conv.agent(context);
    const app = createApp({ harness, conversations: new ConversationStore(harness), models });

    const res = await app.request(`/v1/sessions/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/tools" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: boolean; notice: string };
    expect(body.command).toBe(true);
    expect(body.notice).toContain(`Tools (${agent.tools.length}):`);
    for (const tool of agent.tools) {
      expect(body.notice).toContain(tool.name);
    }

    const bad = await app.request(`/v1/sessions/${conv.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "/tools extra" }),
    });
    expect(bad.status).toBe(400);
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("composer slash command autocomplete includes /tools", () => {
  const matches = filterSlashCommands("tool");
  expect(matches.some(c => c.id === "tools" && c.insert === "/tools")).toBe(true);
});
