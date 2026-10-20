// Verifies the wired runtime: strict config, extension allowlist, MCP (Streamable HTTP, deferred + tool_search,
// secret-free stdio env), cron tools driven by the model + result delivery, improve job sync, delegate scoping.
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { loadConfig, parseConfig } from "./config.js";
import { context } from "./luna.js";
import { IMPROVE_JOB, startRuntime } from "./runtime.js";
import { parseFrontmatter } from "./skills.js";

function buildServer() {
  const s = new McpServer({ name: "demo", version: "1.0.0" });
  s.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
  s.tool("env", "Report whether a secret env var is visible", {}, async () => ({ content: [{ type: "text", text: process.env.LUNA_SECRET_PROBE ? "LEAKED" : "clean" }] }));
  return s;
}

if (process.argv[2] === "stdio-server") {
  await buildServer().connect(new StdioServerTransport());
} else {
  const ok = (m: string) => console.log("OK", m);
  const d = mkdtempSync(join(process.cwd(), ".vrt-"));
  try {
    // ---- config: strict, allowlist, defaults ----
    const bad = (raw: unknown, re: RegExp, why: string) => assert.throws(() => parseConfig(raw, d, {}), re, why);
    bad({ extensions: ["coding", "evil-plugin"] }, /extensions/, "unknown extension");
    bad({ bogus: 1 }, /Unrecognized key|bogus/, "unknown top-level key");
    bad({ mcpServers: [{ name: "a", transport: "stdio", command: "x" }, { name: "a", transport: "stdio", command: "y" }] }, /duplicate MCP/, "dup MCP");
    bad({ mcpServers: [{ name: "a", transport: "stdio", command: "x", shell: true }] }, /shell|Unrecognized/, "unknown MCP key");
    bad({ improve: { schedule: "not cron" } }, /cron/, "bad improve schedule");
    bad({ provider: "anthropic" }, /model is required/, "provider without model");
    const def = parseConfig({}, d, {});
    assert.deepEqual(def.extensions, ["coding", "memory", "skills", "delegate", "cron", "improve", "tool-search", "todo", "ask-user", "recall", "goal", "learn"]);
    assert.equal(def.improve.allowCommandBenchmarks, false);
    assert.equal(def.server.host, "127.0.0.1");
    writeFileSync(join(d, "cfg.json"), JSON.stringify({ dataDir: "./data", extensions: ["memory"] }));
    const fromFile = loadConfig(join(d, "cfg.json"));
    assert.equal(fromFile.dataDir, join(d, "data"));
    ok("config: strict validation, allowlist, defaults, relative paths");

    // ---- frontmatter block scalars ----
    const fm = parseFrontmatter("---\nname: x\ndescription: >\n  folded line one\n  and two\nnotes: |\n  a\n  b\ntools: [t]\n---\nbody");
    assert.equal(fm.data.description, "folded line one and two");
    assert.equal(fm.data.notes, "a\nb");
    assert.deepEqual(fm.data.tools, ["t"]);
    ok("skills frontmatter: folded and literal block scalars");

    // ---- MCP Streamable HTTP server ----
    const http = createServer(async (req, res) => {
      if (req.url !== "/mcp") return void res.writeHead(404).end();
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void t.close(); });
      await buildServer().connect(t);
      await t.handleRequest(req, res);
    }).listen(0, "127.0.0.1");
    await new Promise((r) => http.once("listening", r));
    const port = (http.address() as { port: number }).port;

    // ---- full runtime with faux model ----
    process.env.LUNA_SECRET_PROBE = "sk-should-not-leak";
    const cfg = parseConfig({
      dataDir: join(d, "data"),
      cwd: d,
      mcpServers: [
        { name: "web", transport: "http", url: `http://127.0.0.1:${port}/mcp` },
        { name: "local", transport: "stdio", command: process.execPath, args: ["--import", "tsx", "src/verify-runtime.ts", "stdio-server"], cwd: process.cwd(), defer: false },
        { name: "off", transport: "stdio", command: "/nonexistent", enabled: false },
      ],
      cron: { notifyUrl: "http://notify.invalid/topic" },
      improve: { schedule: "0 3 * * *" },
    }, d, {});
    const faux = fauxProvider();
    const models = createModels(); models.setProvider(faux.provider);
    const fm2 = faux.getModel();
    const model = { provider: fm2.provider, modelId: fm2.id };
    const delivered: { title: string; body: string }[] = [];
    const fakeFetch = (async (_u: string, init: any) => { delivered.push({ title: init.headers.Title, body: init.body }); return new Response("ok"); }) as typeof fetch;
    const logs: string[] = [];
    const rt = await startRuntime(cfg, { models, model, fetch: fakeFetch, log: (m) => logs.push(m) });

    assert.deepEqual(rt.mcp.connections.map((c) => c.name).sort(), ["local", "web"]);
    assert.ok(!logs.some((l) => l.includes("off")), "disabled server must not start");
    ok("MCP: http + stdio connected, disabled server skipped");

    const root = await rt.harness.root(context, { agent: { model } });
    const agent = await root.agent(context);
    const offered = agent.tools.map((t) => t.name);
    const deferred = agent.deferred.map((t) => t.name);
    for (const t of ["bash", "read", "write", "edit", "remember", "recall", "forget", "skill_view", "delegate_task", "cron_create", "cron_list", "cron_get", "cron_update", "cron_toggle", "cron_remove", "cron_run", "cron_stop", "cron_runs", "cron_run_get", "inspect_runs", "extract_lessons", "skill_propose", "skill_rollback", "tool_search", "local__add"])
      assert.ok(offered.includes(t), `missing tool ${t}; offered: ${offered.join(",")}`);
    assert.ok(deferred.includes("web__add") && !offered.includes("web__add"), "http MCP tools should be deferred");
    ok(`all subsystems wired (${offered.length} offered, ${deferred.length} deferred)`);

    // ---- model drives: tool_search loads MCP tool, calls it; checks env; creates cron job ----
    const results: string[] = [];
    const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join(""));
    let step = 0;
    const respond = (c: any) => {
      const tr = c.messages.filter((x: any) => x.role === "toolResult");
      if (tr.length) results[tr.length - 1] = textOf(tr[tr.length - 1]);
      switch (step++) {
        case 0: return fauxAssistantMessage([fauxToolCall("tool_search", { query: "add numbers web" })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("web__add", { a: 20, b: 22 })], { stopReason: "toolUse" });
        case 2: return fauxAssistantMessage([fauxToolCall("local__env", {})], { stopReason: "toolUse" });
        case 3: return fauxAssistantMessage([fauxToolCall("cron_create", { name: "hourly-ping", expr: "@hourly", prompt: "say pong" })], { stopReason: "toolUse" });
        case 4: return fauxAssistantMessage([fauxToolCall("cron_list", {})], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("done")]);
      }
    };
    faux.setResponses(Array(10).fill(respond));
    const s1 = await (await root.submit({ type: "input", content: "go" }, context)).wait(context);
    assert.equal(s1.status, "done", JSON.stringify(s1).slice(0, 300));
    assert.match(results[0]!, /web__add/, "tool_search should load web__add: " + results[0]);
    assert.equal(results[1], "42", "web__add result: " + results[1]);
    ok("tool_search loaded deferred MCP tool over Streamable HTTP; call returned 42");
    assert.equal(results[2], "clean", "stdio MCP saw daemon secret env: " + results[2]);
    ok("stdio MCP server does not inherit daemon secrets");
    assert.match(results[3]!, /created job \d+ "hourly-ping"/);
    assert.match(results[4]!, /hourly-ping \[@hourly\] on/);
    assert.match(results[4]!, new RegExp(`${IMPROVE_JOB} \\[0 3 \\* \\* \\*\\] on`), "improve job synced from config");
    ok("model created a cron job via tools; improve job synced from config");

    // ---- cron fire -> delivery ----
    const job = rt.store!.listJobs().find((j) => j.name === "hourly-ping")!;
    faux.setResponses([fauxAssistantMessage([fauxText("pong")])]);
    await rt.scheduler!.tick(job.nextRun! + 1000);
    await rt.scheduler!.idle();
    const run = rt.store!.runs(job.id)[0]!;
    assert.equal(run.status, "ok");
    const got = delivered.find((x) => x.title.includes("hourly-ping"));
    assert.ok(got && got.body === "pong" && /ok$/.test(got.title), "delivery: " + JSON.stringify(delivered));
    ok("cron run delivered to notifyUrl (title + output)");

    // ---- model drives the edit / run-now / inspect tools through the live runtime scheduler ----
    const cr: string[] = [];
    let cstep = 0;
    const longPrompt = "say pong now " + "please ".repeat(200);
    const crespond = (c: any) => {
      const first = c.messages.find((x: any) => x.role === "user");
      if (first && textOf(first).startsWith("say pong now")) return fauxAssistantMessage([fauxText("pong-now")]);
      const tr = c.messages.filter((x: any) => x.role === "toolResult");
      if (cstep > 0) cr[cstep - 1] = textOf(tr[tr.length - 1]);
      switch (cstep++) {
        case 0: return fauxAssistantMessage([fauxToolCall("cron_update", { id: job.id, prompt: longPrompt, expr: "15 * * * *" })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("cron_get", { id: job.id })], { stopReason: "toolUse" });
        case 2: return fauxAssistantMessage([fauxToolCall("cron_run", { id: job.id })], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("done")]);
      }
    };
    faux.setResponses(Array(10).fill(crespond));
    const cs = await (await root.submit({ type: "input", content: "edit and run" }, context)).wait(context);
    assert.equal(cs.status, "done", JSON.stringify(cs).slice(0, 300));
    assert.match(cr[0]!, /updated job \d+ \(expr, prompt\)/, "cron_update: " + cr[0]);
    const edited = rt.store!.getJob(job.id)!;
    assert.equal(edited.prompt, longPrompt); assert.equal(new Date(edited.nextRun!).getMinutes(), 15);
    assert.ok(cr[1]!.includes(longPrompt), "cron_get shows the full prompt");
    const startedId = Number(/started run #(\d+)/.exec(cr[2]!)?.[1]);
    assert.ok(startedId, "cron_run: " + cr[2]);
    await rt.scheduler!.idle();
    assert.equal(rt.store!.getRun(startedId)!.output, "pong-now", "run-now executed the edited prompt");
    ok("model edited, inspected and ran a job through the runtime scheduler");

    // ---- delegate: children scoped per parent; replayed spawn reuses child ----
    const other = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    const childRes: string[] = [];
    let pstep = 0;
    const isParent = (c: any) => c.messages.some((m: any) => m.role === "user" && textOf(m) === "orchestrate");
    const r2 = (c: any) => {
      if (!isParent(c)) return fauxAssistantMessage([fauxText("child ok")]);
      // only tool results after the "orchestrate" message belong to this run
      const start = c.messages.findIndex((m: any) => m.role === "user" && textOf(m) === "orchestrate");
      const tr = c.messages.slice(start).filter((x: any) => x.role === "toolResult");
      if (tr.length) childRes[tr.length - 1] = textOf(tr[tr.length - 1]);
      switch (pstep++) {
        case 0: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "spawn", task: "do X" })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "wait", timeoutSec: 20 })], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("parent done")]);
      }
    };
    faux.setResponses(Array(10).fill(r2));
    const s2 = await (await root.submit({ type: "input", content: "orchestrate" }, context)).wait(context);
    assert.equal(s2.status, "done");
    const childId = Number(/child (\d+)/.exec(childRes[0]!)![1]);
    assert.match(childRes[1]!, new RegExp(`\\[${childId}\\] done\\nchild ok`));
    // The other conversation lists nothing and may not steer root's child.
    let ostep = 0; const ores: string[] = [];
    const r3 = (c: any) => {
      const tr = c.messages.filter((x: any) => x.role === "toolResult");
      if (tr.length) ores[tr.length - 1] = textOf(tr[tr.length - 1]);
      switch (ostep++) {
        case 0: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "list" })], { stopReason: "toolUse" });
        case 1: return fauxAssistantMessage([fauxToolCall("delegate_task", { action: "steer", ids: [childId], task: "hijack" })], { stopReason: "toolUse" });
        default: return fauxAssistantMessage([fauxText("other done")]);
      }
    };
    faux.setResponses(Array(10).fill(r3));
    const s3 = await (await other.submit({ type: "input", content: "peek" }, context)).wait(context);
    assert.equal(s3.status, "done");
    assert.equal(ores[0], "no children", "other parent saw foreign children: " + ores[0]);
    assert.match(ores[1]!, /steered 0\/1.*not your children/);
    ok("delegate: children scoped to their parent; foreign steer rejected; child inherits work done");

    await rt.close();
    http.closeAllConnections(); http.close();
    console.log("RUNTIME_OK");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  process.exit(0);
}
