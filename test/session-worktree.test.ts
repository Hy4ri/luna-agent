// Auto-worktree end to end: the first write in a project with autoWorktree is refused, session_worktree allocates a branch
// and switches the session, stale main-checkout paths map into the worktree, and finish removes it once the branch merged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import { sessionBranchName } from "../src/session-worktree.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("sessionBranchName slugs the title and falls back to the id", () => {
  assert.equal(sessionBranchName(7, "Fix: the Sidebar!! spinner"), "luna/s7-fix-the-sidebar-spinner");
  assert.equal(sessionBranchName(7, "   "), "luna/s7");
  assert.equal(sessionBranchName(7, null), "luna/s7");
  assert.ok(sessionBranchName(7, "a".repeat(200)).length <= "luna/s7-".length + 40);
});

test("auto-worktree: refuse first write, allocate, map stale paths, finish after merge", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-auto-worktree-")));
  const origin = join(base, "origin.git"), repo = join(base, "repo");
  try {
    execFileSync("git", ["init", "--bare", "-b", "main", origin]);
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.email", "t@test.local"); git(repo, "config", "user.name", "T");
    writeFileSync(join(repo, "root.txt"), "root\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "init");
    git(repo, "remote", "add", "origin", origin); git(repo, "push", "-u", "origin", "main");
    git(repo, "remote", "set-head", "origin", "main");

    const faux = fauxProvider();
    const call = (name: string, args: Record<string, string>) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    faux.setResponses([
      call("write", { path: "a.txt", content: "a\n" }), fauxAssistantMessage([fauxText("blocked")]),
      call("session_worktree", {}), fauxAssistantMessage([fauxText("switched")]),
      call("write", { path: join(repo, "b.txt"), content: "b\n" }), fauxAssistantMessage([fauxText("mapped")]),
      call("session_worktree", { action: "finish" }), fauxAssistantMessage([fauxText("unmerged refused")]),
      call("session_worktree", { action: "finish" }), fauxAssistantMessage([fauxText("finished")]),
      call("write", { path: "c.txt", content: "c\n" }), fauxAssistantMessage([fauxText("blocked again")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const model = faux.getModel(), ref = { provider: model.provider, modelId: model.id };
    const dataDir = join(base, "data");
    mkdirSync(dataDir);
    const rt = await startRuntime(parseConfig({ dataDir, cwd: repo, extensions: ["coding"] }), { models, model: ref });
    try {
      const projects = rt.conversations.projects;
      const project = projects.create("p", repo);
      projects.update(project.id, { autoWorktree: true });
      assert.equal(projects.get(project.id)!.autoWorktree, true);
      const app = createApp({ harness: rt.harness, conversations: rt.conversations, models, agent: { model: ref, cwd: repo }, cwd: repo });
      const res = await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: project.id }) });
      assert.equal(res.status, 201);
      const id = ((await res.json()) as { id: number }).id;
      const conv = (await rt.harness.conversation(id as ConversationId, context))!;
      const turn = async (text: string) => assert.equal((await (await conv.submit({ type: "input", content: text }, context)).wait(context)).status, "done");
      const results = async () => (await conv.entries({}, 100, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");

      await turn("write");
      assert.equal(existsSync(join(repo, "a.txt")), false);
      assert.match(JSON.stringify((await results()).at(-1)!.content), /session_worktree/);
      assert.equal((await conv.agent(context)).cwd, repo);

      await turn("start");
      const wt = join(base, ".luna-worktrees", `repo-s${id}`);
      assert.equal((await conv.agent(context)).cwd, wt);
      assert.equal(git(wt, "branch", "--show-current"), `luna/s${id}-write`); // The title comes from the first message.

      await turn("write absolute path into the main checkout");
      assert.equal(readFileSync(join(wt, "b.txt"), "utf8"), "b\n");
      assert.equal(existsSync(join(repo, "b.txt")), false);

      await turn("finish too early");
      assert.equal((await results()).at(-1)!.isError, true);
      assert.ok(existsSync(wt));

      git(wt, "config", "user.email", "t@test.local"); git(wt, "config", "user.name", "T");
      git(wt, "add", "."); git(wt, "commit", "-m", "work");
      git(wt, "push", "origin", "HEAD:main");
      await turn("finish");
      assert.equal(existsSync(wt), false);
      assert.equal(git(repo, "branch", "--list", `luna/s${id}-write`), "");
      assert.equal((await conv.agent(context)).cwd, repo);

      await turn("write again");
      assert.equal(existsSync(join(repo, "c.txt")), false);
    } finally { await rt.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
