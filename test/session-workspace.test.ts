// Luna runtime integration test: session_workspace tool switches session cwd, updates Git HTTP status,
// delivers agent_changed via session feed, isolates from other sessions, and persists across reopen.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import { openSessionFeed } from "../src/session-feed.js";
import type { AgentEvent } from "../src/session-feed-types.js";

function initGitRepo(dir: string, branch = "main") {
  execFileSync("git", ["init", "-b", branch], { cwd: dir });
  execFileSync("git", ["config", "user.email", "luna@test.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Luna Test"], { cwd: dir });
  writeFileSync(join(dir, "root.txt"), "root-content\n");
  execFileSync("git", ["add", "root.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir });
}

test("session_workspace activates cwd, updates relative read/write, reflects in Git HTTP, emits agent_changed, isolates sessions, persists across reopen, and rejects invalid paths", async () => {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "luna-session-workspace-")));
  const mainRepo = join(baseDir, "main-repo");
  mkdirSync(mainRepo, { recursive: true });
  initGitRepo(mainRepo, "main");

  const wtDir = join(baseDir, "feat-wt");
  execFileSync("git", ["worktree", "add", "-b", "feature/branch", wtDir], { cwd: mainRepo });
  writeFileSync(join(wtDir, "worktree.txt"), "wt-initial\n");

  const faux = fauxProvider();
  faux.setResponses([
    // Turn 1: session_workspace is deferred, so Session 1 loads it with tool_search, then activates the worktree
    fauxAssistantMessage([fauxToolCall("tool_search", { query: "session workspace activate directory" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("session_workspace", { path: wtDir })], { stopReason: "toolUse" }),

    // Turn 2: Session 1 uses relative read and write tools in the SAME runtime session
    fauxAssistantMessage([
      fauxToolCall("read", { path: "worktree.txt" }),
      fauxToolCall("write", { path: "relative-created.txt", content: "created-in-worktree\n" }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("relative tools completed")]),

    // Turn 3: Session 2 does not switch workspace; uses relative read in original repo
    fauxAssistantMessage([fauxToolCall("read", { path: "root.txt" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("session2 root read")]),

    // Turn 4: Session 1 attempts invalid workspace paths
    fauxAssistantMessage([fauxToolCall("session_workspace", { path: "relative/path" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("rejected relative path")]),

    fauxAssistantMessage([fauxToolCall("session_workspace", { path: join(baseDir, "nonexistent-dir") })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("rejected missing path")]),

    fauxAssistantMessage([fauxToolCall("session_workspace", { path: join(mainRepo, "root.txt") })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("rejected file path")]),
  ]);

  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const modelRef = { provider: model.provider, modelId: model.id };

  const dataDir = join(baseDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const cfg = parseConfig({
    dataDir,
    cwd: mainRepo,
    extensions: ["coding", "tool-search"],
  });

  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime(cfg, { models, model: modelRef });
    const app = createApp({
      harness: rt.harness,
      conversations: rt.conversations,
      models,
      agent: { model: modelRef, cwd: mainRepo },
      cwd: mainRepo,
    });

    // Create session 1 and session 2 via in-process HTTP
    const createRes1 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(createRes1.status, 201);
    const s1Id = ((await createRes1.json()) as { id: number }).id;

    const createRes2 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(createRes2.status, 201);
    const s2Id = ((await createRes2.json()) as { id: number }).id;

    const conv1 = (await rt.harness.conversation(s1Id as ConversationId, context))!;
    const conv2 = (await rt.harness.conversation(s2Id as ConversationId, context))!;

    // Initial agent cwd for both sessions should be the default mainRepo
    assert.equal((await conv1.agent(context)).cwd, mainRepo);
    assert.equal((await conv2.agent(context)).cwd, mainRepo);

    // Initial Git HTTP checks for session 1: points to main branch and mainRepo
    const initGit1 = await app.request(`/v1/sessions/${s1Id}/git`);
    assert.equal(initGit1.status, 200);
    const initGitBody1 = (await initGit1.json()) as { branch: string };
    assert.equal(initGitBody1.branch, "main");

    const initChanges1 = await app.request(`/v1/git/changes?session=${s1Id}`);
    assert.equal(initChanges1.status, 200);
    const initChangesBody1 = (await initChanges1.json()) as { branch: string; cwd: string };
    assert.equal(initChangesBody1.branch, "main");
    assert.equal(initChangesBody1.cwd, mainRepo);

    // Watch session feed on conv1 to verify agent_changed event emission
    const feed1 = await openSessionFeed(rt.harness, conv1, undefined, context);
    const events1: AgentEvent[] = [];
    feed1.start(async batch => { events1.push(...batch); });

    try {
    // Step 1: Run Turn 1 in Session 1 to switch workspace
    const turn1 = await (await conv1.submit({ type: "input", content: "switch to worktree" }, context)).wait(context);
    assert.equal(turn1.status, "done");
    await feed1.flush();

    // Verify session 1 agent cwd was updated to wtDir
    assert.equal((await conv1.agent(context)).cwd, wtDir);

    // session_workspace is deferred: not declared upfront, but named in the deferred-tools section; tool_search adds it.
    const systems = (await conv1.entries({}, 50, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "system").reverse();
    assert.ok(systems[0]!.toolsAdded?.some(t => t.name === "read"));
    assert.ok(!systems[0]!.toolsAdded?.some(t => t.name === "session_workspace"), "session_workspace must not be offered upfront");
    const sections = (systems[0] as { sections?: Record<string, string> }).sections ?? {};
    assert.match(sections["deferred-tools"] ?? "", /tool_search[^<]*\bsession_workspace\b/);
    assert.ok(systems.some(m => m.toolsAdded?.some(t => t.name === "session_workspace")), "tool_search loads session_workspace");

    // Verify session feed received an agent_changed event with the new cwd
    const agentChangedEvents = events1.filter((e): e is Extract<AgentEvent, { type: "agent_changed" }> => e.type === "agent_changed");
    assert.ok(agentChangedEvents.length >= 1, "Session feed must emit agent_changed when workspace switches");
    assert.equal(agentChangedEvents[agentChangedEvents.length - 1]!.agent.cwd, wtDir);
    } finally { await feed1.stop(); }

    // Verify other session (session 2) remains untouched at mainRepo
    assert.equal((await conv2.agent(context)).cwd, mainRepo);
    const s2Git = await app.request(`/v1/sessions/${s2Id}/git`);
    assert.equal(s2Git.status, 200);
    assert.equal(((await s2Git.json()) as { branch: string }).branch, "main");
    const s2Changes = await app.request(`/v1/git/changes?session=${s2Id}`);
    assert.equal(s2Changes.status, 200);
    const s2ChangesBody = (await s2Changes.json()) as { branch: string; cwd: string };
    assert.equal(s2ChangesBody.branch, "main");
    assert.equal(s2ChangesBody.cwd, mainRepo);

    // The relative read and write execute after the switch in the SAME run (after tool_search and the switch).
    const results = (await conv1.entries({}, 50, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    assert.deepEqual(results.map(r => r.toolName).sort(), ["read", "session_workspace", "tool_search", "write"]);
    assert.ok(results.every(r => !r.isError));
    assert.match(JSON.stringify(results.find(r => r.toolName === "read")!.content), /wt-initial/);

    // Verify relative write created the file in wtDir, not in mainRepo
    assert.equal(readFileSync(join(wtDir, "relative-created.txt"), "utf8"), "created-in-worktree\n");
    assert.equal(existsSync(join(mainRepo, "relative-created.txt")), false);

    // Verify Git HTTP session status and changes reflect worktree and branch
    const s1GitAfter = await app.request(`/v1/sessions/${s1Id}/git`);
    assert.equal(s1GitAfter.status, 200);
    const s1GitBodyAfter = (await s1GitAfter.json()) as { branch: string; files: Array<{ path: string }> };
    assert.equal(s1GitBodyAfter.branch, "feature/branch");

    const s1ChangesAfter = await app.request(`/v1/git/changes?session=${s1Id}`);
    assert.equal(s1ChangesAfter.status, 200);
    const s1ChangesBodyAfter = (await s1ChangesAfter.json()) as { branch: string; cwd: string; files: Array<{ path: string }> };
    assert.equal(s1ChangesBodyAfter.branch, "feature/branch");
    assert.equal(s1ChangesBodyAfter.cwd, wtDir);
    assert.ok(s1ChangesBodyAfter.files.some(f => f.path === "relative-created.txt"));

    // Step 3: Session 2 executes read against its own unchanged workspace
    const turn3 = await (await conv2.submit({ type: "input", content: "read session 2 file" }, context)).wait(context);
    assert.equal(turn3.status, "done");
    assert.equal((await conv2.agent(context)).cwd, mainRepo);

    // Step 4: Invalid workspace paths fail and leave cwd unchanged
    const turn4Rel = await (await conv1.submit({ type: "input", content: "try relative path" }, context)).wait(context);
    assert.equal(turn4Rel.status, "done");
    assert.equal((await conv1.agent(context)).cwd, wtDir);

    const turn4Missing = await (await conv1.submit({ type: "input", content: "try missing dir" }, context)).wait(context);
    assert.equal(turn4Missing.status, "done");
    assert.equal((await conv1.agent(context)).cwd, wtDir);

    const turn4File = await (await conv1.submit({ type: "input", content: "try file instead of dir" }, context)).wait(context);
    assert.equal(turn4File.status, "done");
    assert.equal((await conv1.agent(context)).cwd, wtDir);
    const failed = (await conv1.entries({}, 100, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult").filter(m => m.toolName === "session_workspace");
    assert.equal(failed.length, 4);
    assert.equal(failed.filter(r => r.isError).length, 3);

    // Close runtime to verify persistence by reopening harness
    await rt.close();
    rt = undefined;

    // Harness reopen: verify persisted agent cwd
    const reopenedHarness = await openLuna({
      dbPath: join(dataDir, "luna.db"),
      models,
      cwd: mainRepo,
      coding: true,
      memory: false,
    });
    try {
      const reopenedConv1 = (await reopenedHarness.conversation(s1Id as ConversationId, context))!;
      const reopenedConv2 = (await reopenedHarness.conversation(s2Id as ConversationId, context))!;
      assert.equal((await reopenedConv1.agent(context)).cwd, wtDir);
      assert.equal((await reopenedConv2.agent(context)).cwd, mainRepo);
    } finally {
      await reopenedHarness.close(context);
    }
  } finally {
    await rt?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
