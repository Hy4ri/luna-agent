import { afterEach, test, expect } from "bun:test";
import { localLauncher, shellEnvironment } from "../src/terminal/pty-host.js";
import { TerminalError, TerminalRegistry, type TerminalInfo, type TerminalListener } from "../src/terminal/registry.js";
import { rejectsWith, throwsWith } from "./support/expect-error.js";

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
  expect(r.get(info.id)?.cols).toBe(120);
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
  expect(state.text).toMatch(/\/tmp\r?$/m);
  expect(!state.text.includes("secret-token")).toBeTruthy();
  expect(shellEnvironment({ LUNA_TOKEN: "x", A: "b" }).LUNA_TOKEN).toBe(undefined);
  r.closeAll();
});

test("exit is reported and the ended terminal stays listed until it is closed", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const { state } = collect(r, info.id);
  r.write(info.id, "exit 3\n");
  await until(() => state.exits.length === 1, "exit event");
  expect(state.exits[0]!.exitCode).toBe(3);
  expect(r.list(1)[0]?.status).toBe("ended");
  r.write(info.id, "ignored\n");
  r.close(info.id);
  expect(state.closed).toBeTruthy();
  expect(r.list(1)).toStrictEqual([]);
});

test("closing a running terminal kills the process and tells attached clients", async () => {
  const r = registry();
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const { state } = collect(r, info.id);
  r.close(info.id);
  expect(state.closed).toBeTruthy();
  expect(state.exits[0]?.endReason).toBe("Closed.");
  throwsWith(() => r.write(info.id, "x"), (e: unknown) => e instanceof TerminalError && e.status === 404);
  r.close(info.id);
});

test("the ninth running terminal in a session is refused, other sessions are not affected", async () => {
  const r = registry();
  for (let i = 0; i < 8; i++) await r.create({ session: 1, worker: null, cwd: "/tmp" });
  await rejectsWith(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 409);
  await r.create({ session: 2, worker: null, cwd: "/tmp" });
  r.closeAll();
});

test("concurrent creates cannot pass the limit", async () => {
  const r = registry({ maxPerSession: 2 });
  const results = await Promise.allSettled([1, 2, 3, 4].map(() => r.create({ session: 1, worker: null, cwd: "/tmp" })));
  expect(results.filter(x => x.status === "fulfilled").length).toBe(2);
  r.closeAll();
});

test("re-attaching replays earlier output once and the ring buffer is bounded", async () => {
  // PTY chunk sizes vary by host. Drive the launcher boundary so an oversized
  // callback and a partially retained oldest chunk are exercised on every run.
  let emit!: (chunk: Buffer) => void;
  const r = registry({ ringBytes: 4096, launcher: async () => ({
    pid: undefined,
    onData: listener => { emit = listener; },
    onExit() {}, write() {}, resize() {}, kill() {},
  }) });
  const info = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const first = collect(r, info.id);
  emit(Buffer.from("marker-one\r\n"));
  first.attached.detach();
  emit(Buffer.from("marker-two\r\n"));
  const second = collect(r, info.id);
  expect(first.state.text).toBe("marker-one\r\n");
  expect(second.state.text).toBe("marker-one\r\nmarker-two\r\n");

  const large = Buffer.alloc(20000, "x");
  emit(large);
  expect(second.state.text).toBe("marker-one\r\nmarker-two\r\n" + large.toString());
  const replay = () => {
    const attached = r.attach(info.id, { data() {}, exit() {}, closed() {} });
    attached.detach();
    return attached.replay;
  };
  expect(replay()).toStrictEqual(Buffer.alloc(4096, "x"));
  emit(Buffer.from("tail"));
  expect(replay()).toStrictEqual(Buffer.from("x".repeat(4092) + "tail"));
  emit(Buffer.alloc(4096, "y"));
  expect(replay()).toStrictEqual(Buffer.alloc(4096, "y"));
  r.closeAll();
});

test("deleting a session closes its terminals only", async () => {
  const r = registry();
  const a = await r.create({ session: 1, worker: null, cwd: "/tmp" });
  const b = await r.create({ session: 2, worker: null, cwd: "/tmp" });
  r.closeSession(1);
  expect(r.get(a.id)).toBe(undefined);
  expect(r.get(b.id)?.status).toBe("running");
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
  expect(listed?.status).toBe("ended");
  expect(listed?.endReason).toBe("Worker went offline.");
  r.closeAll();
});

test("a launcher failure is reported as a 503 and does not use a slot", async () => {
  const r = track(new TerminalRegistry({ env: SH, maxPerSession: 1, launcher: async () => { throw new Error("no pty"); } }));
  await rejectsWith(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 503);
  await rejectsWith(r.create({ session: 1, worker: null, cwd: "/tmp" }), (e: unknown) => e instanceof TerminalError && e.status === 503);
});
