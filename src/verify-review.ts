import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { UsageDoc } from "@earendil-works/pi-durable";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { checkGitArgs, renderReviewHistory } from "./review.js";

const dir = mkdtempSync(join(tmpdir(), "luna-review-"));
const repo = join(dir, "repo"), outside = join(dir, "outside-secret.txt");
mkdirSync(repo);
writeFileSync(outside, "TOP_SECRET");
const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString();
sh("init", "-q"); sh("config", "user.email", "t@example.com"); sh("config", "user.name", "t");
writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
sh("add", "."); sh("commit", "-qm", "base");
writeFileSync(join(repo, "app.ts"), "export const a = 2;\nexport const added = true;\n");
writeFileSync(join(repo, "new.ts"), "export const fresh = 1;\n");
symlinkSync(outside, join(repo, "link.txt"));
const snapshot = () => sh("status", "--porcelain", "--untracked-files=all") + readFileSync(join(repo, "app.ts"), "utf8");

const faux = fauxProvider({ models: [{ id: "main" }, { id: "reviewer" }] }), models = createModels(); models.setProvider(faux.provider);
const main = { provider: faux.getModel("main")!.provider, modelId: "main" };
const raw = { dataDir: join(dir, "data"), cwd: repo, provider: "faux", model: "main", providers: [], extensions: [] as string[], auxiliary: { review: { provider: main.provider, model: "reviewer" } } };
const cfgPath = join(dir, "config.json");
writeFileSync(cfgPath, JSON.stringify(raw));
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: cfgPath }, { models, model: main, log: () => {} });
const app = createApp({ harness: rt.harness, models, sideCommands: rt.sideCommands, agent: { model: main }, token: "test" });
const request = (id: unknown, content: string) => app.request(`/v1/sessions/${id}/messages?async=1`, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ content }) });
async function finish(sessionId: string, jobId: string) {
  for (let i = 0; i < 2000; i++) {
    const job = rt.sideCommands.list(sessionId).find(j => j.id === jobId);
    if (job && job.status !== "running") return job;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("review job did not finish");
}
try {
  // Pure checks of the read-only guards.
  assert.equal(checkGitArgs(["diff", "--stat", "HEAD"]), undefined);
  assert.equal(checkGitArgs(["log", "--oneline", "-n5", "--", "src/a.ts"]), undefined);
  for (const bad of [["push"], ["commit", "-m", "x"], ["checkout", "x"], ["config", "a", "b"], ["diff", "--output=/tmp/x"], ["diff", "--ext-diff"], ["diff", "--out=/tmp/x"],
    ["show", "/etc/passwd"], ["diff", "--", "../x"], ["log", "--exec=x"], ["blame", "app.ts"], []]) assert.ok(checkGitArgs(bad), `blocked: ${bad.join(" ")}`);
  const history: Message[] = [
    { role: "user", content: "FIRST REQUEST add field", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "SECRET_ARGS" } }], api: "x", provider: "x", model: "x", usage: {} as never, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "TOOL_OUTPUT_BODY" }], isError: false, timestamp: 3 },
    { role: "user", content: "CORRECTION use camelCase", timestamp: 4 },
  ];
  const rendered = renderReviewHistory(history);
  assert.ok(rendered.includes("FIRST REQUEST") && rendered.includes("CORRECTION") && rendered.includes("#3 USER"));
  assert.ok(!rendered.includes("TOOL_OUTPUT_BODY") && !rendered.includes("SECRET_ARGS") && rendered.includes("[tools: bash]"));
  console.log("OK guards and brief: allowlisted git, user requests kept, tool output not dumped");

  // Real session, real route, real HTTP command.
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: main, cwd: repo } }, context);
  const empty = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: main, cwd: repo } }, context);
  assert.equal((await request(empty.id, "/review")).status, 400, "empty session has no history");
  faux.setResponses([fauxAssistantMessage("I changed app.ts and added the field.")]);
  await (await conv.submit({ type: "input", content: "REQUIREMENT_MARKER: set a to 2 and add `added`" }, context)).wait(context);
  const entriesBefore = JSON.stringify((await conv.entries({ order: "ascending" }, 1000, undefined, context)).items.map(e => e.id));
  const before = snapshot();

  const results = new Map<string, { text: string; isError: boolean }>();
  const seenModels: string[] = [];
  const grab = (ctx: { messages: Message[] }) => {
    for (const m of ctx.messages) if (m.role === "toolResult") results.set(m.toolCallId, { text: m.content.map(b => b.type === "text" ? b.text : "").join(""), isError: m.isError });
  };
  let brief = "", toolNames: string[] = [], systemText = "";
  faux.setResponses([
    (ctx, _o, _s, model) => {
      seenModels.push(model.id); toolNames = (ctx as any).messages.flatMap((m: any) => m.toolsAdded ?? []).map((t: any) => t.name);
      systemText = JSON.stringify(ctx.messages.filter(m => m.role === "system"));
      brief = JSON.stringify(ctx.messages.filter(m => m.role === "user"));
      return fauxAssistantMessage([
        fauxToolCall("read_file", { path: "app.ts" }, { id: "t-read" }),
        fauxToolCall("read_file", { path: "../outside-secret.txt" }, { id: "t-escape" }),
        fauxToolCall("read_file", { path: "link.txt" }, { id: "t-link" }),
        fauxToolCall("git", { args: ["log", "--oneline"] }, { id: "t-log" }),
        fauxToolCall("git", { args: ["commit", "-am", "x"] }, { id: "t-commit" }),
        fauxToolCall("git", { args: ["diff", "--output=" + join(dir, "leak")] }, { id: "t-output" }),
        fauxToolCall("search", { pattern: "added" }, { id: "t-search" }),
        fauxToolCall("session_message", { index: 1 }, { id: "t-msg" }),
        fauxToolCall("bash", { command: "touch " + join(dir, "ran") }, { id: "t-bash" }),
        fauxToolCall("write", { path: join(repo, "evil.ts"), content: "x" }, { id: "t-write" }),
      ], { stopReason: "toolUse" });
    },
    ctx => {
      grab(ctx);
      // Change the workspace while the review is running.
      writeFileSync(join(repo, "late.ts"), "late\n");
      return fauxAssistantMessage("## Verdict\nCovered. REVIEW_REPORT_MARKER\n## Findings\nNo findings");
    },
  ]);
  const started = await request(conv.id, "/review check the added field");
  assert.equal(started.status, 202);
  const receipt = await started.json() as any;
  assert.equal(receipt.command, true); assert.equal(receipt.job.kind, "review"); assert.match(receipt.job.id, /^review_\d{6}_[a-f0-9]{6}$/);
  const job = await finish(String(conv.id), receipt.job.id);
  assert.equal(job.status, "complete", job.text);

  assert.deepEqual(seenModels, ["reviewer"], "ran on the configured review model, not the session model");
  assert.ok(brief.includes("REQUIREMENT_MARKER") && brief.includes("I changed app.ts") && brief.includes("check the added field"), "brief has requirement, claim, focus");
  assert.ok(brief.includes("export const added = true") && brief.includes("new.ts") && brief.includes("Branch:"), "brief has the real diff and untracked file");
  assert.ok(systemText.includes("cannot run tests"), "reviewer rules are in the system prompt");
  assert.ok(results.get("t-read")!.text.includes("2\texport const added = true;"), "read_file works");
  for (const id of ["t-escape", "t-link"]) { assert.ok(results.get(id)!.isError, id); assert.ok(!results.get(id)!.text.includes("TOP_SECRET"), id); assert.match(results.get(id)!.text, /outside the working directory/); }
  assert.ok(results.get("t-log")!.text.includes("base"), "git log works");
  assert.ok(results.get("t-commit")!.isError && /not allowed/.test(results.get("t-commit")!.text));
  assert.ok(results.get("t-output")!.isError && !existsSync(join(dir, "leak")));
  assert.ok(results.get("t-search")!.text.includes("app.ts:2:"), "search works");
  assert.ok(results.get("t-msg")!.text.includes("I changed app.ts") || results.get("t-msg")!.text.includes("REQUIREMENT_MARKER"), "session_message works");
  for (const id of ["t-bash", "t-write"]) assert.ok(results.get(id)!.isError && /read-only/.test(results.get(id)!.text), id);
  assert.ok(!existsSync(join(dir, "ran")) && !existsSync(join(repo, "evil.ts")), "no command ran and no file was written");
  assert.ok(job.text.includes("REVIEW_REPORT_MARKER"));
  assert.ok(job.text.includes("No tests were run"));
  assert.ok(job.text.includes("workspace changed while this review ran"), "stale workspace is flagged");
  assert.equal(snapshot().replace(/\?\? late\.ts\n/, ""), before, "reviewer did not change tracked or untracked work");
  assert.equal(sh("log", "--oneline").trim().split("\n").length, 1, "no commit was made");
  const entriesAfter = JSON.stringify((await conv.entries({ order: "ascending" }, 1000, undefined, context)).items.map(e => e.id));
  assert.equal(entriesAfter, entriesBefore, "review writes nothing into the session transcript");
  const usage = await rt.harness.snapshot(UsageDoc, conv.id, context);
  assert.ok(usage?.models[`${main.provider}/reviewer`], "usage recorded against the session under the review model");
  assert.ok(toolNames.length === 0 || !toolNames.some(n => ["bash", "write", "edit"].includes(n)));
  console.log("OK /review: routed model, real diff brief, read-only tools enforced, stale warning, no writes");

  // No route: refuse, do not fall back to the session model.
  const settings = rt.settings!, edited = settings.read(); delete (edited.auxiliary as any).review;
  settings.replace(edited, settings.revision());
  const refused = await request(conv.id, "/review");
  assert.equal(refused.status, 400); assert.match(((await refused.json()) as any).error ?? "", /no review model/);
  assert.equal(faux.getPendingResponseCount(), 0);
  console.log("OK /review refuses without auxiliary.review and applies the setting live");

  // Not a git repo: still reviews by reading files.
  const plain = join(dir, "plain"); mkdirSync(plain); writeFileSync(join(plain, "x.ts"), "x\n");
  const e2 = settings.read(); e2.auxiliary = { ...e2.auxiliary, review: { provider: main.provider, model: "reviewer" } }; settings.replace(e2, settings.revision());
  const c2 = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: main, cwd: plain } }, context);
  faux.setResponses([fauxAssistantMessage("done")]);
  await (await c2.submit({ type: "input", content: "do x" }, context)).wait(context);
  let plainBrief = "";
  faux.setResponses([ctx => { plainBrief = JSON.stringify(ctx.messages.filter(m => m.role === "user")); return fauxAssistantMessage("## Verdict\nCannot tell."); }]);
  const r2 = await (await request(c2.id, "/review")).json() as any;
  const j2 = await finish(String(c2.id), r2.job.id);
  assert.equal(j2.status, "complete", j2.text); assert.ok(plainBrief.includes("Not a git repository"));
  console.log("OK /review works outside git");
  console.log("REVIEW_OK");
} finally { await rt.close(); rmSync(dir, { recursive: true, force: true }); }
