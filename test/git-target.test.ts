// Source Control opens a project's repository on the main host or on a linked execution machine.
import { test, expect } from "bun:test";
import { GitError } from "../src/git-control.js";
import { resolveProjectTarget, type TargetDeps } from "../src/git-target.js";
import { throwsWith } from "./support/expect-error.js";

const project = (over: Record<string, unknown> = {}) => ({ id: 1, name: "p", cwd: "/main/p", workerDirs: [] as { worker: number; cwd: string }[], ...over });
const deps = (p: ReturnType<typeof project> | undefined, online: number[] = []): TargetDeps => ({
  project: () => p,
  online: id => online.includes(id),
});
const fail = (fn: () => unknown, status: number) => throwsWith(fn, e => e instanceof GitError && e.status === status);

test("a project with a main directory and no machine opens on the main host", () => {
  expect(resolveProjectTarget(1, undefined, deps(project()))).toStrictEqual({ worker: null, cwd: "/main/p" });
  expect(resolveProjectTarget(1, "main", deps(project()))).toStrictEqual({ worker: null, cwd: "/main/p" });
});

test("a machine selects that machine's directory", () => {
  const p = project({ workerDirs: [{ worker: 2, cwd: "/w/p" }] });
  expect(resolveProjectTarget(1, "2", deps(p, [2]))).toStrictEqual({ worker: 2, cwd: "/w/p" });
});

test("a worker-only project picks its first online machine", () => {
  const p = project({ cwd: "", workerDirs: [{ worker: 2, cwd: "/a" }, { worker: 3, cwd: "/b" }] });
  expect(resolveProjectTarget(1, undefined, deps(p, [3]))).toStrictEqual({ worker: 3, cwd: "/b" });
});

test("offline, unlinked, and missing targets fail with a clear status", () => {
  const p = project({ workerDirs: [{ worker: 2, cwd: "/w/p" }] });
  fail(() => resolveProjectTarget(1, "2", deps(p, [])), 503);
  fail(() => resolveProjectTarget(1, "9", deps(p, [9])), 400);
  fail(() => resolveProjectTarget(1, "x", deps(p)), 400);
  fail(() => resolveProjectTarget(1, undefined, deps(project({ cwd: "", workerDirs: [{ worker: 2, cwd: "/a" }] }), [])), 503);
  fail(() => resolveProjectTarget(1, undefined, deps(project({ cwd: "" }))), 400);
  fail(() => resolveProjectTarget(1, undefined, deps(undefined)), 400);
  fail(() => resolveProjectTarget(1, undefined, deps(project({ general: true }))), 400);
});
