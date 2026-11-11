// Contract: a request frame the socket drops under backpressure fails at once as "not sent"; it never hangs.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Link } from "../src/workers.js";

test("a dropped exec frame resolves as a not-sent failure instead of waiting forever", async () => {
  const logs: string[] = [];
  const ws = { send: () => 0, ping() {}, close() {} } as never;
  const link = new Link({ id: 1, name: "w", createdAt: 0, lastSeenAt: null, capabilities: null }, ws, {} as never, m => logs.push(m));
  try {
    const result = await Promise.race([
      link.call("exec", id => ({ t: "call", id, method: "exec" }) as never, BACKGROUND_CONTEXT),
      new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 500)),
    ]);
    assert.notEqual(result, "hung");
    assert.equal((result as { ok: boolean }).ok, false);
    assert.match(String((result as { error: Error }).error?.message), /not sent\. Nothing ran/);
    assert.equal(logs.length, 1);
  } finally { link.drop("test"); }
});
