// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { resolveQuickSessionTarget, resolveSnapProject, sortProjects } from "../../web/src/lib/projects.ts";

test("sortProjects places favourites first and keeps relative order inside each group", () => {
  const input = [
    { name: "alpha", favorite: false },
    { name: "beta", favorite: true },
    { name: "gamma", favorite: false },
    { name: "delta", favorite: true },
  ];
  assert.deepEqual(sortProjects(input).map(p => p.name), ["beta", "delta", "alpha", "gamma"]);
});

test("resolveQuickSessionTarget defaults to main host for Chats, General, or main-host projects", () => {
  const projects = [
    { id: 0, general: true, cwd: "" },
    { id: 1, cwd: "/home/m57/Projects/luna-pi", workerDirs: [{ worker: 2, cwd: "/srv/luna-pi" }] },
  ];
  const workers = [{ id: 2, name: "arm-worker", online: true }];

  assert.deepEqual(resolveQuickSessionTarget(null, "Chats", projects, workers), { worker: null });
  assert.deepEqual(resolveQuickSessionTarget(0, "General", projects, workers), { worker: null });
  assert.deepEqual(resolveQuickSessionTarget(1, "luna-pi", projects, workers), { worker: null });
});

test("resolveQuickSessionTarget picks the first online linked worker for worker-only projects", () => {
  const projects = [
    {
      id: 5,
      cwd: "",
      workerDirs: [
        { worker: 10, cwd: "/srv/offline-box" },
        { worker: 11, cwd: "/srv/online-box" },
      ],
    },
  ];
  const workers = [
    { id: 10, name: "box-a", online: false },
    { id: 11, name: "box-b", online: true },
  ];

  assert.deepEqual(resolveQuickSessionTarget(5, "remote-only", projects, workers), { worker: 11 });
});

test("resolveQuickSessionTarget disables quick-new with a clear reason when no linked machine is online", () => {
  const projects = [
    { id: 6, cwd: "", workerDirs: [{ worker: 10, cwd: "/srv/offline-box" }] },
    { id: 7, cwd: "", workerDirs: [] },
  ];
  const workers = [{ id: 10, name: "box-a", online: false }];

  assert.deepEqual(resolveQuickSessionTarget(6, "remote-only", projects, workers), {
    worker: 10,
    disabledReason: "box-a is offline",
  });
  assert.deepEqual(resolveQuickSessionTarget(7, "unlinked", projects, workers), {
    worker: null,
    disabledReason: "unlinked is not linked to a machine",
  });
});

const snapProjects = [
  { id: 0, name: "General", general: true, favorite: false },
  { id: 2, name: "hermes-mobile", favorite: true },
  { id: 5, name: "luna-pi", favorite: false },
];

test("resolveSnapProject uses the saved project when it exists in the project list", () => {
  assert.equal(resolveSnapProject(snapProjects, "2", 5), 2);
  assert.equal(resolveSnapProject(snapProjects, "0", 5), 0);
});

test("resolveSnapProject defaults to luna-pi when no valid saved project exists", () => {
  assert.equal(resolveSnapProject(snapProjects, null, 2), 5);
  assert.equal(resolveSnapProject(snapProjects, "", 0), 5);
  assert.equal(resolveSnapProject(snapProjects, "999", 2), 5);
  assert.equal(resolveSnapProject(snapProjects, "not-a-number", 2), 5);
});

test("resolveSnapProject falls back to active project or first project when luna-pi is absent", () => {
  const withoutLunaPi = [
    { id: 0, name: "General" },
    { id: 2, name: "hermes-mobile" },
  ];
  assert.equal(resolveSnapProject(withoutLunaPi, null, 2), 2);
  assert.equal(resolveSnapProject(withoutLunaPi, "999", null), 0);
  assert.equal(resolveSnapProject([], null, 2), 2);
  assert.equal(resolveSnapProject([], null, null), null);
});
