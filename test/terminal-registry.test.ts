import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { localLauncher, shellEnvironment } from "../src/terminal/pty-host.js";
import { TerminalError, TerminalRegistry, type TerminalInfo, type TerminalListener } from "../src/terminal/registry.js";

const SH = { SHELL: "/bin/sh", PATH: process.env.PATH ?? "" };
// Every registry is closed after its test, so a failed assertion never leaves a shell running.
const made: TerminalRegistry[] = [];
const track = (r: TerminalRegistry) => { made.push(r); return r; };
afterEach(() => { for (const r of made.splice(0)) r.closeAll(); });
const registry = (extra: Partial<ConstructorParameters<typeof TerminalRegistry>[0]> = {}) =>
  track(new TerminalRegistry({ launcher: localLauncher, env: SH, ...extra }));

function collect(r: TerminalRegistry, id: string) {
  const state = { text: "", exits: [] as TerminalInfo[], closed: false };
  const listener: TerminalListener = {
    data: c => { state.text += c.toString("utf8"); },
    exit: i => { state.exits.push(i); },
    closed: () => { state.closed = true; },
  };
  const attached = r.attach(id, listener);
  state.text += attached.replay.toString("utf8");
  return { state, attached };
}

async function until(fn: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

test("a terminal runs a shell, takes input, and reports its size after a resize", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp", cols: 100, rows: 30 });
  const { state } = collect(r, info.id);
  r.write(info.id, "stty size\n");
  await until(() => state.text.includes("30 100"), "initial size");
  r.resize(info.id, 120, 40);
  assert.equal(r.get(info.id)?.cols, 120);
  r.write(info.id, "stty size\n");
  await until(() => state.text.includes("40 120"), "resized size");
  r.closeAll();
});

test("the shell starts in the requested directory and never sees the daemon token", async () => {
  const r = registry({ env: { ...SH, LUNA_TOKEN: "secret-token" } });
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const { state } = collect(r, info.id);
  r.write(info.id, "pwd; echo token=[$LUNA_TOKEN]\n");
  await until(() => state.text.includes("token=[]"), "token line");
  assert.match(state.text, /\/tmp\r?$/m);
  assert.ok(!state.text.includes("secret-token"));
  assert.equal(shellEnvironment({ LUNA_TOKEN: "x", A: "b" }).LUNA_TOKEN, undefined);
  r.closeAll();
});

test("exit is reported and the ended terminal stays listed until it is closed", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const { state } = collect(r, info.id);
  r.write(info.id, "exit 3\n");
  await until(() => state.exits.length === 1, "exit event");
  assert.equal(state.exits[0]!.exitCode, 3);
  assert.equal(r.list(1)[0]?.status, "ended");
  r.write(info.id, "ignored\n");
  r.close(info.id);
  assert.ok(state.closed);
  assert.deepEqual(r.list(1), []);
});

test("closing a running terminal kills the process and tells attached clients", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const { state } = collect(r, info.id);
  r.close(info.id);
  assert.ok(state.closed);
  assert.equal(state.exits[0]?.endReason, "Closed.");
  assert.throws(() => r.write(info.id, "x"), (e: unknown) => e instanceof TerminalError && e.status === 404);
  r.close(info.id);
});

test("the ninth running terminal in a session is refused, other sessions are not affected", async () => {
  const r = registry();
  for (let i = 0; i < 8; i++) await r.create({ session: 1, worker: null, cwd: "/tmp" });
  await assert.rejects(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 409);
  await r.create({ session: 2, worker: null, cwd: "/tmp" });
  r.closeAll();
});

test("concurrent creates cannot pass the limit", async () => {
  const r = registry({ maxPerSession: 2 });
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => r.create({ session: 1, worker: null, cwd: "/tmp" })));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 2);
  r.closeAll();
});

test("re-attaching replays earlier output once and the ring buffer is bounded", async () => {
  const r = registry({ ringBytes: 4096 });
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const first = collect(r, info.id);
  r.write(info.id, "echo marker-one\n");
  await until(() => first.state.text.includes("marker-one"), "first output");
  first.attached.detach();
  r.write(info.id, "echo marker-two\n");
  await new Promise(res => setTimeout(res, 300));
  const second = collect(r, info.id);
  assert.equal(second.state.text.split("marker-one").length - 1, 2, "echoed command line plus output, each once");
  assert.ok(second.state.text.includes("marker-two"));
  r.write(info.id, "head -c 20000 /dev/zero | tr '\\0' 'x'; echo\n");
  await until(() => (second.state.text.match(/x/g)?.length ?? 0) >= 20000, "bulk output");
  assert.ok(r.attach(info.id, { data() {}, exit() {}, closed() {} }).replay.length <= 4096 + 8192);
  r.closeAll();
});

test("deleting a session closes its terminals only", async () => {
  const r = registry();
  const a = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const b = await r.create({ session: 2, worker: null, cwd: "/tmp" });
  r.closeSession(1);
  assert.equal(r.get(a.id), undefined);
  assert.equal(r.get(b.id)?.status, "running");
  r.closeAll();
});

test("a worker going offline ends its terminals but keeps them listed", async () => {
  const r = track(new TerminalRegistry({
    env: SH,
    launcher: async (_worker, options) => localLauncher(null, options),
  }));
  const info = await r.create({ session: 1, worker: 7, cwd: "/tmp" });
  r.endWorker(7, "Worker went offline.");
  const listed = r.get(info.id);
  assert.equal(listed?.status, "ended");
  assert.equal(listed?.endReason, "Worker went offline.");
  r.closeAll();
});

test("a launcher failure is reported as a 503 and does not use a slot", async () => {
  const r = track(new TerminalRegistry({ env: SH, maxPerSession: 1, launcher: async () => { throw new Error("no pty"); } }));
  await assert.rejects(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 503);
  await assert.rejects(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 503);
});
