// Luna runtime integration test: session_worktree switch switches session cwd, updates Git HTTP status,
// delivers agent_changed via session feed, isolates from other sessions, and persists across reopen.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openLuna } from "../src/luna.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import { openSessionFeed } from "../src/session-feed.js";
import type { AgentEvent } from "../src/session-feed-types.js";

function git(cwd: string, ...args: string[]): void {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) throw new Error(res.stderr.toString() || `git ${args[0]} failed`);
}

function initGitRepo(dir: string, branch = "main") {
  git(dir, "init", "-b", branch);
  git(dir, "config", "user.email", "luna@test.local");
  git(dir, "config", "user.name", "Luna Test");
  writeFileSync(join(dir, "root.txt"), "root-content\n");
  git(dir, "add", "root.txt");
  git(dir, "commit", "-m", "initial commit");
}

test("session_worktree switch activates cwd, updates relative read/write, reflects in Git HTTP, emits agent_changed, isolates sessions, persists across reopen, and rejects invalid paths", async () => {
  const baseDir = realpathSync(mkdtempSync(join(tmpdir(), "luna-session-workspace-")));
  const mainRepo = join(baseDir, "main-repo");
  mkdirSync(mainRepo, { recursive: true });
  initGitRepo(mainRepo, "main");

  const wtDir = join(baseDir, "feat-wt");
  git(mainRepo, "worktree", "add", "-b", "feature/branch", wtDir);
  writeFileSync(join(wtDir, "worktree.txt"), "wt-initial\n");

  const faux = fauxProvider();
  faux.setResponses([
    // Turn 1: Session 1 activates the existing worktree with session_worktree switch
    fauxAssistantMessage([fauxToolCall("session_worktree", { action: "switch", path: wtDir })], { stopReason: "toolUse" }),

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
    fauxAssistantMessage([fauxToolCall("session_worktree", { action: "switch", path: "relative/path" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("rejected relative path")]),

    fauxAssistantMessage([fauxToolCall("session_worktree", { action: "switch", path: join(baseDir, "nonexistent-dir") })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("rejected missing path")]),

    fauxAssistantMessage([fauxToolCall("session_worktree", { action: "switch", path: join(mainRepo, "root.txt") })], { stopReason: "toolUse" }),
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
    expect(createRes1.status).toBe(201);
    const s1Id = ((await createRes1.json()) as { id: number }).id;

    const createRes2 = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(createRes2.status).toBe(201);
    const s2Id = ((await createRes2.json()) as { id: number }).id;

    const conv1 = (await rt.harness.conversation(s1Id as ConversationId, context))!;
    const conv2 = (await rt.harness.conversation(s2Id as ConversationId, context))!;

    // Initial agent cwd for both sessions should be the default mainRepo
    expect((await conv1.agent(context)).cwd).toBe(mainRepo);
    expect((await conv2.agent(context)).cwd).toBe(mainRepo);

    // Initial Git HTTP checks for session 1: points to main branch and mainRepo
    const initGit1 = await app.request(`/v1/sessions/${s1Id}/git`);
    expect(initGit1.status).toBe(200);
    const initGitBody1 = (await initGit1.json()) as { branch: string };
    expect(initGitBody1.branch).toBe("main");

    const initChanges1 = await app.request(`/v1/git/changes?session=${s1Id}`);
    expect(initChanges1.status).toBe(200);
    const initChangesBody1 = (await initChanges1.json()) as { branch: string; cwd: string };
    expect(initChangesBody1.branch).toBe("main");
    expect(initChangesBody1.cwd).toBe(mainRepo);

    // Watch session feed on conv1 to verify agent_changed event emission
    const feed1 = await openSessionFeed(rt.harness, conv1, undefined, context);
    const events1: AgentEvent[] = [];
    feed1.start(async batch => { events1.push(...batch); });

    try {
    // Step 1: Run Turn 1 in Session 1 to switch workspace
    const turn1 = await (await conv1.submit({ type: "input", content: "switch to worktree" }, context)).wait(context);
    expect(turn1.status).toBe("done");
    await feed1.flush();

    // Verify session 1 agent cwd was updated to wtDir
    expect((await conv1.agent(context)).cwd).toBe(wtDir);

    // Verify session feed received an agent_changed event with the new cwd
    const agentChangedEvents = events1.filter((e): e is Extract<AgentEvent, { type: "agent_changed" }> => e.type === "agent_changed");
    expect(agentChangedEvents.length >= 1).toBeTruthy() /* "Session feed must emit agent_changed when workspace switches" */;
    expect(agentChangedEvents[agentChangedEvents.length - 1]!.agent.cwd).toBe(wtDir);
    } finally { await feed1.stop(); }

    // Verify other session (session 2) remains untouched at mainRepo
    expect((await conv2.agent(context)).cwd).toBe(mainRepo);
    const s2Git = await app.request(`/v1/sessions/${s2Id}/git`);
    expect(s2Git.status).toBe(200);
    expect(((await s2Git.json()) as { branch: string }).branch).toBe("main");
    const s2Changes = await app.request(`/v1/git/changes?session=${s2Id}`);
    expect(s2Changes.status).toBe(200);
    const s2ChangesBody = (await s2Changes.json()) as { branch: string; cwd: string };
    expect(s2ChangesBody.branch).toBe("main");
    expect(s2ChangesBody.cwd).toBe(mainRepo);

    // The relative read and write execute after the switch in the SAME run (after the switch).
    const results = (await conv1.entries({}, 50, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    expect(results.map(r => r.toolName).sort()).toEqual(["read", "session_worktree", "write"]);
    expect(results.every(r => !r.isError)).toBeTruthy();
    expect(JSON.stringify(results.find(r => r.toolName === "read")!.content)).toMatch(/wt-initial/);

    // Verify relative write created the file in wtDir, not in mainRepo
    expect(readFileSync(join(wtDir, "relative-created.txt"), "utf8")).toBe("created-in-worktree\n");
    expect(existsSync(join(mainRepo, "relative-created.txt"))).toBe(false);

    // Verify Git HTTP session status and changes reflect worktree and branch
    const s1GitAfter = await app.request(`/v1/sessions/${s1Id}/git`);
    expect(s1GitAfter.status).toBe(200);
    const s1GitBodyAfter = (await s1GitAfter.json()) as { branch: string; files: Array<{ path: string }> };
    expect(s1GitBodyAfter.branch).toBe("feature/branch");

    const s1ChangesAfter = await app.request(`/v1/git/changes?session=${s1Id}`);
    expect(s1ChangesAfter.status).toBe(200);
    const s1ChangesBodyAfter = (await s1ChangesAfter.json()) as { branch: string; cwd: string; files: Array<{ path: string }> };
    expect(s1ChangesBodyAfter.branch).toBe("feature/branch");
    expect(s1ChangesBodyAfter.cwd).toBe(wtDir);
    expect(s1ChangesBodyAfter.files.some(f => f.path === "relative-created.txt")).toBeTruthy();

    // Step 3: Session 2 executes read against its own unchanged workspace
    const turn3 = await (await conv2.submit({ type: "input", content: "read session 2 file" }, context)).wait(context);
    expect(turn3.status).toBe("done");
    expect((await conv2.agent(context)).cwd).toBe(mainRepo);

    // Step 4: Invalid workspace paths fail and leave cwd unchanged
    const turn4Rel = await (await conv1.submit({ type: "input", content: "try relative path" }, context)).wait(context);
    expect(turn4Rel.status).toBe("done");
    expect((await conv1.agent(context)).cwd).toBe(wtDir);

    const turn4Missing = await (await conv1.submit({ type: "input", content: "try missing dir" }, context)).wait(context);
    expect(turn4Missing.status).toBe("done");
    expect((await conv1.agent(context)).cwd).toBe(wtDir);

    const turn4File = await (await conv1.submit({ type: "input", content: "try file instead of dir" }, context)).wait(context);
    expect(turn4File.status).toBe("done");
    expect((await conv1.agent(context)).cwd).toBe(wtDir);
    const failed = (await conv1.entries({}, 100, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult").filter(m => m.toolName === "session_worktree");
    expect(failed.length).toBe(4);
    expect(failed.filter(r => r.isError).length).toBe(3);

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
      expect((await reopenedConv1.agent(context)).cwd).toBe(wtDir);
      expect((await reopenedConv2.agent(context)).cwd).toBe(mainRepo);
    } finally {
      await reopenedHarness.close(context);
    }
  } finally {
    await rt?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
