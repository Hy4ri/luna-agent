// Auto-worktree end to end: the first write in a project with autoWorktree is refused, session_worktree allocates a branch
// and switches the session, stale main-checkout paths map into the worktree, and finish removes it once the branch merged.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { createApp } from "../src/server.js";
import { sessionBranchName } from "../src/session-worktree.js";

const git = (cwd: string, ...args: string[]) => {
  const res = Bun.spawnSync(["git", ...args], { cwd });
  if (!res.success) throw new Error(res.stderr.toString() || `git ${args[0]} failed`);
  return res.stdout.toString().trim();
};

test("sessionBranchName slugs the title and falls back to the id", () => {
  expect(sessionBranchName(7, "Fix: the Sidebar!! spinner")).toBe("luna/s7-fix-the-sidebar-spinner");
  expect(sessionBranchName(7, "   ")).toBe("luna/s7");
  expect(sessionBranchName(7, null)).toBe("luna/s7");
  expect(sessionBranchName(7, "a".repeat(200)).length <= "luna/s7-".length + 40).toBeTruthy();
});

test("auto-worktree: refuse first write, allocate, map stale paths, finish after merge", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-auto-worktree-")));
  const origin = join(base, "origin.git"), repo = join(base, "repo");
  try {
    const initOrigin = Bun.spawnSync(["git", "init", "--bare", "-b", "main", origin]);
    if (!initOrigin.success) throw new Error(initOrigin.stderr.toString() || "git init origin failed");
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
      expect(projects.get(project.id)!.autoWorktree).toBe(true);
      const app = createApp({ harness: rt.harness, conversations: rt.conversations, models, agent: { model: ref, cwd: repo }, cwd: repo });
      const res = await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: project.id }) });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: number }).id;
      const conv = (await rt.harness.conversation(id as ConversationId, context))!;
      const turn = async (text: string) => expect((await (await conv.submit({ type: "input", content: text }, context)).wait(context)).status).toBe("done");
      const results = async () => (await conv.entries({}, 100, undefined, context)).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");

      await turn("write");
      expect(existsSync(join(repo, "a.txt"))).toBe(false);
      expect(JSON.stringify((await results()).at(-1)!.content)).toMatch(/session_worktree/);
      expect((await conv.agent(context)).cwd).toBe(repo);

      await turn("start");
      const wt = join(base, ".luna-worktrees", `repo-s${id}`);
      expect((await conv.agent(context)).cwd).toBe(wt);
      expect(git(wt, "branch", "--show-current")).toBe(`luna/s${id}-write`); // The title comes from the first message.

      await turn("write absolute path into the main checkout");
      expect(readFileSync(join(wt, "b.txt"), "utf8")).toBe("b\n");
      expect(existsSync(join(repo, "b.txt"))).toBe(false);

      await turn("finish too early");
      expect((await results()).at(-1)!.isError).toBe(true);
      expect(existsSync(wt)).toBeTruthy();

      git(wt, "config", "user.email", "t@test.local"); git(wt, "config", "user.name", "T");
      git(wt, "add", "."); git(wt, "commit", "-m", "work");
      git(wt, "push", "origin", "HEAD:main");
      await turn("finish");
      expect(existsSync(wt)).toBe(false);
      expect(git(repo, "branch", "--list", `luna/s${id}-write`)).toBe("");
      expect((await conv.agent(context)).cwd).toBe(repo);

      await turn("write again");
      expect(existsSync(join(repo, "c.txt"))).toBe(false);
    } finally { await rt.close(); }
  } finally { rmSync(base, { recursive: true, force: true }); }
});
