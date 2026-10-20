import assert from "node:assert/strict";
import type { ConversationId, Cursor, EntryRecord, Tx } from "@earendil-works/pi-durable";
import { newestMessageTime } from "./session-activity.js";

type Page = Awaited<ReturnType<Tx["scanEntries"]>>;
const id = 42 as ConversationId;
// These fixtures deliberately include invalid message timestamps and roles.
const entry = (kind: string, messages?: { role: string; timestamp?: number }[]): EntryRecord => ({
  id: 10 as EntryRecord["id"], conversationId: id, kind,
  ...(messages && { model: messages as unknown as NonNullable<EntryRecord["model"]> }),
});
const message = (kind: "pi.user" | "pi.assistant", timestamp: number) => entry(kind, [{ role: kind.slice(3), timestamp }]);
const cursor1: Cursor = { page: 1 }, cursor2: Cursor = { page: 2 };
function recordingTx(pages: Page[]) {
  let calls = 0;
  const tx: Pick<Tx, "scanEntries"> = {
    async scanEntries(query, limit, cursor) {
      const index = calls++;
      assert.deepEqual(query, { conversationId: id, order: "descending" });
      assert.equal(limit, [16, 64][index] ?? 200, "pages start small and grow to 200");
      assert.equal(cursor, index === 0 ? undefined : pages[index - 1]!.next, "cursor must continue the previous page");
      assert.ok(index < pages.length, "must not request an older page after finding a valid message");
      return pages[index]!;
    },
  };
  return { tx, calls: () => calls };
}

// A valid newest entry stops the scan immediately, including iteration within its page.
const poison = entry("pi.user");
Object.defineProperty(poison, "kind", { get() { throw new Error("older entry must not be inspected"); } });
{
  const fake = recordingTx([{ items: [message("pi.assistant", 2000), poison], next: cursor1 }]);
  assert.equal(await newestMessageTime(fake.tx, id), 2000);
  assert.equal(fake.calls(), 1);
}
// Entry order, not the largest timestamp across all history, defines the newest message.
{
  const fake = recordingTx([{ items: [message("pi.user", 1000), message("pi.assistant", 9999999999999)] }]);
  assert.equal(await newestMessageTime(fake.tx, id), 1000);
  assert.equal(fake.calls(), 1);
}
// Ignore bookkeeping, missing model payloads, invalid timestamps and mismatched roles.
{
  const fake = recordingTx([{ items: [
    message("pi.assistant", Number.NaN), message("pi.user", -1), message("pi.assistant", Infinity),
    entry("pi.user", [{ role: "user" }]), entry("pi.assistant", [{ role: "user", timestamp: 5000 }]),
    entry("test.bookkeeping", [{ role: "assistant", timestamp: 9000 }]), entry("pi.user"),
    message("pi.user", 3000),
  ] }]);
  assert.equal(await newestMessageTime(fake.tx, id), 3000);
}
// A long bookkeeping tail can require pagination. Stop before the older message-history page.
{
  const fake = recordingTx([
    { items: Array.from({ length: 200 }, () => entry("test.bookkeeping")), next: cursor1 },
    { items: [entry("pi.assistant", []), message("pi.user", 2500)], next: cursor2 },
  ]);
  assert.equal(await newestMessageTime(fake.tx, id), 2500);
  assert.equal(fake.calls(), 2);
}
{
  const fake = recordingTx([{ items: [entry("test.bookkeeping")], next: cursor1 }, { items: [] }]);
  assert.equal(await newestMessageTime(fake.tx, id), null);
  assert.equal(fake.calls(), 2);
}
{
  const fake = recordingTx([{ items: [message("pi.user", 0)] }]);
  assert.equal(await newestMessageTime(fake.tx, id), 0);
}
{
  const fake = recordingTx([{ items: [entry("pi.assistant", [
    { role: "assistant", timestamp: 100 }, { role: "assistant", timestamp: 500 },
    { role: "assistant", timestamp: 300 }, { role: "user", timestamp: 9000 },
  ])] }]);
  assert.equal(await newestMessageTime(fake.tx, id), 500);
}
console.log("SESSION_ACTIVITY_OK: bounded scans, pagination, entry order, role and timestamp validation");
