// Contract: two requests with the same session ID (a generation and its background compaction summary) both finish.
// A fake opencode service stands in for `opencode serve`; it answers each prompt only when the test says so.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";

const ROUTES = ["/api/session", "/api/session/{sessionID}/prompt", "/api/session/{sessionID}/interrupt",
  "/api/experimental/mcp/{server}", "/api/experimental/mcp/{server}/connect", "/api/event", "/api/model",
  "/api/experimental/session/{sessionID}/instructions/entries/{key}"];

function fakeOpencode() {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const prompts: { sessionId: string; text: string }[] = [];
  const deleted = new Set<string>();
  let sessions = 0;
  const emit = (sessionId: string, type: string, data: Record<string, unknown> = {}) => {
    if (deleted.has(sessionId)) return;
    const chunk = encoder.encode(`data: ${JSON.stringify({ type, data: { sessionID: sessionId, ...data } })}\n\n`);
    for (const controller of streams) {
      try { controller.enqueue(chunk); } catch { streams.delete(controller); }
    }
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const json = (value: unknown) => Response.json(value);
      if (path === "/api/info") return json({ version: "2.1.4" });
      if (path === "/openapi.json") return json({ paths: Object.fromEntries(ROUTES.map(r => [r, {}])) });
      if (path === "/api/event") {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            c.enqueue(encoder.encode(": open\n\n"));
            streams.add(c);
          },
          cancel() {
            streams.delete(controller);
          },
        });
        req.signal.addEventListener("abort", () => streams.delete(controller), { once: true });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (path === "/api/session" && req.method === "POST") return json({ data: { id: `ses_${++sessions}` } });
      const prompt = path.match(/^\/api\/session\/([^/]+)\/prompt$/);
      if (prompt) {
        const body = await req.json() as { text: string };
        prompts.push({ sessionId: prompt[1]!, text: body.text });
        return json({});
      }
      const session = path.match(/^\/api\/session\/([^/]+)$/);
      if (session && req.method === "DELETE") deleted.add(session[1]!);
      return json({});
    },
  });
  return { server, prompts, deleted, emit };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const end = Date.now() + 5_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("a background summary with the same session ID does not hang the live generation", async () => {
  const fake = fakeOpencode();
  const url = `http://127.0.0.1:${fake.server.port}`;
  const home = mkdtempSync(join(tmpdir(), "luna-opencode-test-"));
  mkdirSync(join(home, "opencode"), { recursive: true });
  writeFileSync(join(home, "opencode", "service.json"), JSON.stringify({ password: "test" }));
  const executable = join(home, "opencode-fake");
  writeFileSync(executable, `#!/bin/sh\necho "listening on ${url}"\n`);
  chmodSync(executable, 0o755);
  process.env.XDG_CONFIG_HOME = home;
  process.env.LUNA_OPENCODE_EXECUTABLE = executable;
  try {

  const { opencodeCliProvider } = await import("../src/opencode-cli.js");
  const provider = opencodeCliProvider();
  const model = provider.getModels()[0]!;
  const ask = (system: string, text: string) => {
    const messages = [
      { role: "system", content: system, timestamp: 1 },
      { role: "user", content: text, timestamp: 2 },
    ] as any;
    return (async () => {
      let final: any;
      for await (const event of provider.streamSimple(model, { messages } as any, { sessionId: "conversation-1" })) {
        if (event.type === "done" || event.type === "error") final = event;
      }
      return final.type === "done" ? final.message : final.error;
    })();
  };

  // The generation is in flight on its opencode session.
  const generation = ask("You are Luna.", "continue the work");
  const live = await until(() => fake.prompts.find(p => p.text.includes("continue the work")), "the generation prompt");

  // The compaction summary starts with the same session ID before the generation finishes.
  const summary = ask("You are a context summarization assistant.", "summarize this");
  const side = await until(() => fake.prompts.find(p => p.text.includes("summarize this")), "the summary prompt");
  expect(side.sessionId).not.toBe(live.sessionId) /* "the summary must not reuse the live opencode session" */;
  fake.emit(side.sessionId, "session.text.delta", { delta: "the summary" });
  fake.emit(side.sessionId, "session.execution.succeeded");
  const summarized = await summary;
  expect(summarized.stopReason).toBe("stop") /* summarized.errorMessage */;
  expect(summarized.content.find((c: any) => c.type === "text")?.text).toBe("the summary");

  // The generation's session survived the summary and its answer still arrives.
  expect(!fake.deleted.has(live.sessionId)).toBeTruthy() /* "the summary must not delete the live opencode session" */;
  fake.emit(live.sessionId, "session.text.delta", { delta: "done" });
  fake.emit(live.sessionId, "session.execution.succeeded");
  const answered = await Promise.race([
    generation,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the generation hung after the summary")), 5_000)),
  ]);
  expect(answered.stopReason).toBe("stop") /* answered.errorMessage */;
  expect(answered.content.find((c: any) => c.type === "text")?.text).toBe("done");
  } finally { fake.server.stop(true); }
});

// Contract: a Luna thinking level reaches opencode as the model variant (ACP "effort"), clamped to the variants offered.
test("thinking levels map to opencode variants", async () => {
  const { variantLevels, variantFor } = await import("../src/opencode-cli.js");
  const { getSupportedThinkingLevels, clampThinkingLevel } = await import("@earendil-works/pi-ai");
  expect(variantLevels([])).toEqual({ reasoning: false });
  const m = { ...variantLevels([{ id: "low" }, { id: "high" }, { id: "max" }]), id: "x", provider: "opencode-cli" } as any;
  expect(getSupportedThinkingLevels(m)).toEqual(["off", "low", "high", "max"]);
  expect(variantFor(m, clampThinkingLevel(m, "medium"))).toBe("high");
  expect(variantFor(m, "max")).toBe("max");
  expect(variantFor(m, "off")).toBe(undefined) /* "off without a none variant runs the model default" */;
  const n = { ...variantLevels([{ id: "none" }, { id: "low" }]) } as any;
  expect(variantFor(n, "off")).toBe("none");
  expect(variantFor({ reasoning: false }, "high")).toBe(undefined);
});

// Contract: a changed opencode executable or config directory gets its own service.
// A service cached for another executable (e.g. the host's real opencode) is never reused.
test("a changed opencode executable starts its own service instead of reusing the cached one", async () => {
  const start = async () => {
    const fake = fakeOpencode();
    const url = `http://127.0.0.1:${fake.server.port}`;
    const home = mkdtempSync(join(tmpdir(), "luna-opencode-test-"));
    mkdirSync(join(home, "opencode"), { recursive: true });
    writeFileSync(join(home, "opencode", "service.json"), JSON.stringify({ password: "test" }));
    const executable = join(home, "opencode-fake");
    writeFileSync(executable, `#!/bin/sh\necho "listening on ${url}"\n`);
    chmodSync(executable, 0o755);
    return { ...fake, home, executable };
  };
  const a = await start(), b = await start();
  const saved = { home: process.env.XDG_CONFIG_HOME, exe: process.env.LUNA_OPENCODE_EXECUTABLE };
  try {
    const { opencodeCliProvider } = await import("../src/opencode-cli.js");
    const provider = opencodeCliProvider();
    const model = provider.getModels()[0]!;
    const run = async (fake: typeof a, text: string) => {
      process.env.XDG_CONFIG_HOME = fake.home;
      process.env.LUNA_OPENCODE_EXECUTABLE = fake.executable;
      const messages = [{ role: "system", content: "You are Luna.", timestamp: 1 }, { role: "user", content: text, timestamp: 2 }] as any;
      const done = (async () => { for await (const _ of provider.streamSimple(model, { messages } as any, { sessionId: `conv-${text}` })) { /* drain */ } })();
      const sent = await until(() => fake.prompts.find(p => p.text.includes(text)), `the "${text}" prompt on its own service`);
      fake.emit(sent.sessionId, "session.text.delta", { delta: "ok" });
      fake.emit(sent.sessionId, "session.execution.succeeded");
      await done;
    };
    await run(a, "first");
    await run(b, "second");
    expect(a.prompts.some(p => p.text.includes("second"))).toBe(false) /* "the old executable's service must not get the new prompt" */;
  } finally {
    process.env.XDG_CONFIG_HOME = saved.home; process.env.LUNA_OPENCODE_EXECUTABLE = saved.exe;
    for (const f of [a, b]) { f.server.stop(true); }
  }
}, 20_000);
