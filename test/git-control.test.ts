// Local Git actions run against real temporary repositories; nothing touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll as after, test } from "bun:test";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createGitControl, GitError, type Workspace } from "../src/git-control.js";

const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

/** A repository with one commit on `main`, pushed to a bare origin. */
function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-git-")));
  dirs.push(base);
  const origin = join(base, "origin.git"), cwd = join(base, "work");
  mkdirSync(cwd);
  git(base, "init", "-q", "--bare", "-b", "main", origin);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Test"); git(cwd, "config", "user.email", "t@example.com"); git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git(cwd, "add", "a.txt"); git(cwd, "commit", "-qm", "first");
  git(cwd, "remote", "add", "origin", origin); git(cwd, "push", "-q", "-u", "origin", "main");
  const w: Workspace = { machine: "main", env: new NodeExecutionEnv({ cwd }) };
  return { cwd, w, ctl: createGitControl() };
}
const fail = async (p: Promise<unknown>, status: number) => assert.rejects(p, e => e instanceof GitError && e.status === status);

test("stage all stages tracked changes and new files; unstage all clears the index", async () => {
  const { cwd, w, ctl } = repo();
  writeFileSync(join(cwd, "a.txt"), "changed\n"); writeFileSync(join(cwd, "new.txt"), "n\n");
  const staged = await ctl.mutate(w, "stage", { all: true });
  assert.equal(staged.changes.files.every(f => f.staged), true);
  assert.equal(staged.changes.files.length, 2);
  const cleared = await ctl.mutate(w, "unstage", { all: true });
  assert.equal(cleared.changes.files.some(f => f.staged), false);
  assert.equal(cleared.changes.files.length, 2);
});

test("unstage all works before the first commit", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-git-"))); dirs.push(base);
  git(base, "init", "-q", "-b", "main"); writeFileSync(join(base, "x.txt"), "x\n");
  const w: Workspace = { machine: "main", env: new NodeExecutionEnv({ cwd: base }) }, ctl = createGitControl();
  assert.equal((await ctl.mutate(w, "stage", { all: true })).changes.files[0]?.staged, true);
  assert.equal((await ctl.mutate(w, "unstage", { all: true })).changes.files.some(f => f.staged), false);
});

test("amend rewrites the last commit and takes staged files", async () => {
  const { cwd, w, ctl } = repo();
  writeFileSync(join(cwd, "b.txt"), "b\n"); git(cwd, "add", "b.txt"); git(cwd, "commit", "-qm", "local only");
  writeFileSync(join(cwd, "c.txt"), "c\n"); git(cwd, "add", "c.txt");
  const before = git(cwd, "rev-parse", "HEAD");
  await ctl.mutate(w, "commit", { message: "reworded", amend: true });
  assert.notEqual(git(cwd, "rev-parse", "HEAD"), before);
  assert.equal(git(cwd, "log", "-1", "--format=%s"), "reworded");
  assert.equal(git(cwd, "show", "--name-only", "--format=", "HEAD"), "b.txt\nc.txt");
});

test("amend with nothing staged only rewords", async () => {
  const { cwd, w, ctl } = repo();
  writeFileSync(join(cwd, "b.txt"), "b\n"); git(cwd, "add", "b.txt"); git(cwd, "commit", "-qm", "old");
  await ctl.mutate(w, "commit", { message: "new", amend: true });
  assert.equal(git(cwd, "log", "-1", "--format=%s"), "new");
});

test("amend of a pushed commit needs force; unborn branches refuse", async () => {
  const { cwd, w, ctl } = repo();
  const before = git(cwd, "rev-parse", "HEAD");
  await fail(ctl.mutate(w, "commit", { message: "x", amend: true }), 409);
  assert.equal(git(cwd, "rev-parse", "HEAD"), before);
  await ctl.mutate(w, "commit", { message: "forced", amend: true, force: true });
  assert.equal(git(cwd, "log", "-1", "--format=%s"), "forced");

  const base = realpathSync(mkdtempSync(join(tmpdir(), "luna-git-"))); dirs.push(base);
  git(base, "init", "-q", "-b", "main");
  await fail(ctl.mutate({ machine: "main", env: new NodeExecutionEnv({ cwd: base }) }, "commit", { message: "x", amend: true }), 400);
});

test("a plain commit still needs staged files", async () => {
  const { w, ctl } = repo();
  await fail(ctl.mutate(w, "commit", { message: "nothing" }), 400);
});

test("the staged diff lists staged files only", async () => {
  const { cwd, w, ctl } = repo();
  writeFileSync(join(cwd, "a.txt"), "changed\n"); writeFileSync(join(cwd, "b.txt"), "b\n");
  git(cwd, "add", "a.txt");
  const d = await ctl.stagedDiff(w);
  assert.match(d.stat, /a\.txt/);
  assert.doesNotMatch(d.patch, /b\.txt/);
  assert.match(d.patch, /\+changed/);
  assert.equal(d.truncated, false);
});

test("discard restores tracked files, removes untracked ones, and refuses staged files", async () => {
  const { cwd, w, ctl } = repo();
  writeFileSync(join(cwd, "a.txt"), "changed\n"); writeFileSync(join(cwd, "new.txt"), "n\n"); writeFileSync(join(cwd, "s.txt"), "s\n");
  git(cwd, "add", "s.txt");
  await fail(ctl.mutate(w, "discard", { paths: ["s.txt"] }), 409);
  await fail(ctl.mutate(w, "discard", { paths: ["../etc/passwd"] }), 400);
  const r = await ctl.mutate(w, "discard", { paths: ["a.txt", "new.txt"] });
  assert.equal(git(cwd, "show", "HEAD:a.txt"), "a");
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(cwd, "new.txt")), false);
  assert.deepEqual(r.changes.files.map(f => f.path), ["s.txt"]);
});

test("stash saves changes, lists them, then pops or drops by index", async () => {
  const { cwd, w, ctl } = repo();
  await fail(ctl.mutate(w, "stash", {}), 400);
  writeFileSync(join(cwd, "a.txt"), "changed\n"); writeFileSync(join(cwd, "u.txt"), "u\n");
  await ctl.mutate(w, "stash", { message: "wip", includeUntracked: true });
  assert.equal((await ctl.changes(w)).files.length, 0);
  const list = await ctl.stashes(w);
  assert.equal(list.length, 1);
  assert.match(list[0]!.subject, /wip/);
  await fail(ctl.mutate(w, "stash-pop", { index: 5 }), 409);
  await ctl.mutate(w, "stash-pop", { index: 0 });
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "changed\n");
  assert.equal((await ctl.stashes(w)).length, 0);
  await ctl.mutate(w, "stash", {});
  await ctl.mutate(w, "stash-drop", { index: 0 });
  assert.equal((await ctl.stashes(w)).length, 0);
  assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), "a\n");
});

test("delete-branch removes merged branches, guards unmerged, current and default", async () => {
  const { cwd, w, ctl } = repo();
  git(cwd, "branch", "merged");
  git(cwd, "switch", "-qc", "work"); writeFileSync(join(cwd, "w.txt"), "w\n"); git(cwd, "add", "w.txt"); git(cwd, "commit", "-qm", "w");
  git(cwd, "switch", "-q", "main");
  await fail(ctl.mutate(w, "delete-branch", { branch: "main" }), 409);
  await fail(ctl.mutate(w, "delete-branch", { branch: "nope" }), 400);
  await ctl.mutate(w, "delete-branch", { branch: "merged" });
  await fail(ctl.mutate(w, "delete-branch", { branch: "work" }), 409);
  await ctl.mutate(w, "delete-branch", { branch: "work", force: true });
  assert.equal(git(cwd, "branch", "--format=%(refname:short)"), "main");
});

test("update-from-default merges origin's default, and aborts cleanly on conflict", async () => {
  const { cwd, w, ctl } = repo();
  const other = join(cwd, "..", "other");
  git(cwd, "clone", "-q", join(cwd, "..", "origin.git"), other);
  git(other, "config", "user.name", "T"); git(other, "config", "user.email", "t@example.com"); git(other, "config", "commit.gpgsign", "false");
  git(cwd, "switch", "-qc", "feat");
  writeFileSync(join(other, "n.txt"), "n\n"); git(other, "add", "n.txt"); git(other, "commit", "-qm", "n"); git(other, "push", "-q", "origin", "main");
  writeFileSync(join(cwd, "dirty.txt"), "d\n");
  await fail(ctl.mutate(w, "update-from-default", {}), 409);
  rmSync(join(cwd, "dirty.txt"));
  await ctl.mutate(w, "update-from-default", {});
  assert.equal(existsSync(join(cwd, "n.txt")), true);
  // Conflict: both sides edit a.txt.
  writeFileSync(join(cwd, "a.txt"), "mine\n"); git(cwd, "commit", "-qam", "mine");
  writeFileSync(join(other, "a.txt"), "theirs\n"); git(other, "commit", "-qam", "theirs"); git(other, "push", "-q", "origin", "main");
  const head = git(cwd, "rev-parse", "HEAD");
  await fail(ctl.mutate(w, "update-from-default", {}), 409);
  assert.equal(git(cwd, "rev-parse", "HEAD"), head);
  assert.equal(git(cwd, "status", "--porcelain"), "");
});

test("checkout-pr fetches the pull ref, switches, and refuses a dirty tree or diverged local branch", async () => {
  const { cwd, w, ctl } = repo();
  const bare = join(cwd, "..", "origin.git");
  git(cwd, "switch", "-qc", "topic");
  writeFileSync(join(cwd, "pr.txt"), "pr\n"); git(cwd, "add", "pr.txt"); git(cwd, "commit", "-qm", "pr");
  git(cwd, "push", "-q", "origin", "topic:refs/pull/5/head");
  git(cwd, "switch", "-q", "main");
  writeFileSync(join(cwd, "dirty.txt"), "d\n");
  await fail(ctl.mutate(w, "checkout-pr", { number: 5 }), 409);
  rmSync(join(cwd, "dirty.txt"));
  await ctl.mutate(w, "checkout-pr", { number: 5 });
  assert.equal(git(cwd, "branch", "--show-current"), "pr-5");
  assert.equal(existsSync(join(cwd, "pr.txt")), true);
  // Local commit on pr-5 diverges from a new PR head: left untouched.
  writeFileSync(join(cwd, "local.txt"), "l\n"); git(cwd, "add", "local.txt"); git(cwd, "commit", "-qm", "local");
  git(cwd, "switch", "-q", "main");
  git(cwd, "switch", "-qc", "other-head", "main");
  writeFileSync(join(cwd, "o.txt"), "o\n"); git(cwd, "add", "o.txt"); git(cwd, "commit", "-qm", "o");
  git(cwd, "push", "-q", "-f", "origin", "other-head:refs/pull/5/head");
  git(cwd, "switch", "-q", "main");
  const before = git(cwd, "rev-parse", "pr-5");
  await fail(ctl.mutate(w, "checkout-pr", { number: 5 }), 409);
  assert.equal(git(cwd, "rev-parse", "pr-5"), before);
  void bare;
});

test("amend refuses a commit pushed to a branch that is not the upstream", async () => {
  const { cwd, w, ctl } = repo();
  git(cwd, "switch", "-qc", "side");
  writeFileSync(join(cwd, "s.txt"), "s\n"); git(cwd, "add", "s.txt"); git(cwd, "commit", "-qm", "s");
  git(cwd, "push", "-q", "origin", "side"); // no upstream set: side has none
  const before = git(cwd, "rev-parse", "HEAD");
  await fail(ctl.mutate(w, "commit", { message: "x", amend: true }), 409);
  assert.equal(git(cwd, "rev-parse", "HEAD"), before);
  // A purely local commit on top is not pushed and can be amended.
  writeFileSync(join(cwd, "l.txt"), "l\n"); git(cwd, "add", "l.txt"); git(cwd, "commit", "-qm", "l");
  await ctl.mutate(w, "commit", { message: "reworded", amend: true });
  assert.equal(git(cwd, "log", "-1", "--format=%s"), "reworded");
});
