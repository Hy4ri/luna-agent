// Local Git actions run against real temporary repositories; nothing touches the network.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
