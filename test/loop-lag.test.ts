import { expect, test } from "bun:test";
import { LoopLagMonitor } from "../src/loop-lag.js";

test("lag monitor buckets drift per minute and logs stalls of one second or more", () => {
  const logs: string[] = [];
  const m = new LoopLagMonitor(message => logs.push(message), 100);
  (m as unknown as { last: number }).last = 0;
  const base = Date.UTC(2026, 10, 12, 12, 0, 0);
  m.sample(100, base);          // on time: 0 lag
  m.sample(350, base + 250);    // 150 ms late
  m.sample(1050, base + 950);   // 600 ms late
  m.sample(2350, base + 61_000); // next minute, 1200 ms late
  const v = m.view();
  expect(v.recent).toHaveLength(2);
  expect(v.recent[0]).toMatchObject({ samples: 3, maxMs: 600, over100: 2, over500: 1, totalLagMs: 750 });
  expect(v.current).toMatchObject({ samples: 1, maxMs: 1200, over500: 1 });
  expect(v.worst?.ms).toBe(1200);
  expect(logs).toEqual(["event loop stalled 1200 ms"]);
});
