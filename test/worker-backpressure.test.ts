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

test("a dropped control frame closes the link instead of leaving it out of sync", () => {
  const logs: string[] = [];
  const closed: Array<[number | undefined, string | undefined]> = [];
  const ws = { send: () => 0, ping() {}, close: (code?: number, reason?: string) => { closed.push([code, reason]); } } as never;
  const link = new Link({ id: 1, name: "w", createdAt: 0, lastSeenAt: null, capabilities: null }, ws, {} as never, m => logs.push(m));
  try {
    link.send({ t: "abort", id: 7 });
    assert.deepEqual(closed, [[1013, "worker link congested"]]);
    assert.match(logs[0]!, /dropped abort frame/);
  } finally { link.drop("test"); }
});

test("the worker treats a socket over its buffer limit as congested", async () => {
  const { linkCongested } = await import("../src/worker.js");
  assert.equal(linkCongested({ bufferedAmount: 100 }, 100), false);
  assert.equal(linkCongested({ bufferedAmount: 101 }, 100), true);
});
