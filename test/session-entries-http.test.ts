import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { openLuna, context } from "../src/luna.js";
import { ConversationStore } from "../src/conversations.js";
import { createApp } from "../src/server.js";

type Page = { entries: { id: number }[]; hasMore: boolean; nextCursor: number | null };

// The transcript pages back through history with this route. It must return the same entries and cursors as the
// full session route, and nothing else.
test("entries pages match the session route's entries and cursors without the session state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-session-entries-"));
  const models = createModels();
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false });
  try {
    const conv = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
    for (let i = 0; i < 7; i++) {
      await harness.commit(tx => tx.appendEntry(conv.id, { kind: "pi.user", model: [{ role: "user", content: `message ${i}`, timestamp: 1 }] } as never), context);
    }
    const app = createApp({ harness, conversations: new ConversationStore(harness), models });
    const read = async (path: string) => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      return (await res.json()) as Page & Record<string, unknown>;
    };
    const pages = async (route: (before: number | null) => string) => {
      const out: Page[] = [];
      let before: number | null = null;
      do {
        const page = await read(route(before));
        out.push({ entries: page.entries, hasMore: page.hasMore, nextCursor: page.nextCursor });
        before = page.nextCursor;
      } while (before !== null && out.length < 10);
      return out;
    };
    const lean = await pages(before => `/v1/sessions/${conv.id}/entries?view=ui&limit=3${before === null ? "" : `&before=${before}`}`);
    const full = await pages(before => `/v1/sessions/${conv.id}?view=ui&limit=3${before === null ? "" : `&before=${before}`}`);
    expect(lean.map(p => p.entries.length)).toEqual([3, 3, 1]);
    expect(lean).toEqual(full);
    expect(Object.keys(await read(`/v1/sessions/${conv.id}/entries?limit=3`)).sort()).toEqual(["entries", "hasMore", "nextCursor"]);
    expect((await app.request(`/v1/sessions/${conv.id}/entries?before=-1`)).status).toBe(400);
    expect((await app.request("/v1/sessions/999999/entries")).status).toBe(404);
  } finally {
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
});
