// Contract: the git, terminal, tool-error, skill-use and prompt detectors file cards only when their threshold is met.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bgLeftovers, projectSetupRepeat, promptRepeat, skillsUnused, toolErrorRepeat, worktreeOrphans } from "../src/wife/detectors3.js";
import { listSessionWorktrees, removeSessionWorktree } from "../src/wife/git.js";

const DAY = 86_400_000;

test("worktree_orphan files merged or session-gone trees and warns about dirty ones", () => {
  const w = { path: "/w/a", branch: "luna/s1", sessionId: 1, merged: true, dirty: false, sessionGone: false };
  const cards = worktreeOrphans([w, { ...w, path: "/w/b", merged: false }, { ...w, path: "/w/c", merged: false, sessionGone: true, dirty: true }]);
  assert.deepEqual(cards.map(c => c.fingerprint), ["worktree_orphan:/w/a", "worktree_orphan:/w/c"]);
  assert.match(cards[1]!.body, /will not remove/);
});

test("bg_leftover needs a running terminal in an idle session", () => {
  const t = [{ id: "a", session: 1, status: "running" }, { id: "b", session: 2, status: "running" }, { id: "c", session: 1, status: "exited" }];
  assert.deepEqual(bgLeftovers(t, s => s === 1).map(c => c.payload.terminalId), ["a"]);
});

test("tool_error_repeat needs a 20% error rate on 10+ calls in 3 sessions, and folds the tools into one card", () => {
  const cards = toolErrorRepeat([
    { name: "bash", calls: 400, errors: 9, sessions: 3, sample: [1, 2, 3] },   // 2%: normal
    { name: "web", calls: 20, errors: 9, sessions: 2, sample: [1, 2] },        // 2 sessions
    { name: "edit", calls: 9, errors: 9, sessions: 3, sample: [1, 2, 3] },     // under 10 calls
    { name: "browser", calls: 30, errors: 6, sessions: 3, sample: [4, 5, 6] }, // 20%
    { name: "ssh", calls: 10, errors: 5, sessions: 4, sample: [7, 4] },        // 50%
  ], "w1");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.fingerprint, "tool_error_repeat:w1");
  assert.deepEqual((cards[0]!.payload.tools as { name: string }[]).map(t => t.name), ["ssh", "browser"]);
  assert.deepEqual(cards[0]!.evidence.map(e => e.sessionId), [7, 4, 5]);
  assert.equal(toolErrorRepeat([{ name: "bash", calls: 400, errors: 9, sessions: 3, sample: [1] }], "w1").length, 0);
});

test("skill_unused skips external, young, and recently used skills", () => {
  const now = 100 * DAY;
  const skills = [{ name: "old", managed: true, modified: 0 }, { name: "ext", managed: false, modified: 0 }, { name: "new", managed: true, modified: 90 * DAY }, { name: "used", managed: true, modified: 0 }];
  assert.deepEqual(skillsUnused(skills, new Map([["used", 80 * DAY]]), now).map(c => c.payload.name), ["old"]);
});

test("prompt_repeat needs 3 sessions on a daily-or-slower rhythm; digits are ignored", () => {
  const text = (n: number) => `Summarize the open pull requests for repo number ${n} please`;
  const msgs = [1, 2, 3].map(i => ({ conv: i, ts: i * DAY, text: text(i) }));
  assert.equal(promptRepeat(msgs).length, 1);
  assert.equal(promptRepeat(msgs.map((m, i) => ({ ...m, ts: i * 1000 }))).length, 0);   // a burst is not a rhythm
  assert.equal(promptRepeat(msgs.slice(0, 2)).length, 0);
});

test("project_setup_repeat groups by project and ignores General", () => {
  const setup = "Read AGENTS.md, run the tests first, then continue with the task I describe below please. ";
  const f = [1, 2, 3].map(i => ({ conv: i, project: 4, text: setup + i }));
  assert.equal(projectSetupRepeat(f).length, 1);
  assert.equal(projectSetupRepeat(f.map(x => ({ ...x, project: 0 }))).length, 0);
  // Crew and peer messages are written by sessions, not typed by m57.
  const peer = (n: number) => `[message from session #${n} "Lead": a peer session, not m57. It is your crew lead: it created this session and gives you tasks.`;
  assert.equal(projectSetupRepeat([1, 2, 3].map(i => ({ conv: i, project: 4, text: peer(100 + i) }))).length, 0);
  assert.equal(promptRepeat([1, 2, 3].map(i => ({ conv: i, ts: i * DAY, text: peer(100 + i) }))).length, 0);
});

test("session worktrees: a fresh one is not removed dirty, a clean one is removed with its branch", () => {
  const sh = (cwd: string, ...a: string[]) => { const p = Bun.spawnSync(a, { cwd }); assert.equal(p.exitCode, 0, p.stderr.toString()); return p.stdout.toString().trim(); };
  const root = mkdtempSync(join(tmpdir(), "wife-git-"));
  const repo = join(root, "repo");
  sh(root, "git", "init", "-q", "-b", "main", repo);
  sh(repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(root, "wt");
  sh(repo, "git", "worktree", "add", "-q", "-b", "luna/s7-x", wt);
  const [one] = listSessionWorktrees([repo]);
  assert.equal(one!.branch, "luna/s7-x"); assert.equal(one!.merged, true); assert.equal(one!.dirty, false);
  writeFileSync(join(wt, "f"), "x");
  assert.throws(() => removeSessionWorktree(wt, "luna/s7-x"), /uncommitted/);
  Bun.spawnSync(["rm", join(wt, "f")]);
  removeSessionWorktree(wt, "luna/s7-x");
  assert.deepEqual(listSessionWorktrees([repo]), []);
  assert.equal(sh(repo, "git", "branch", "--list", "luna/s7-x"), "");
  assert.throws(() => removeSessionWorktree(wt, "feature"), /not a session/);
});
