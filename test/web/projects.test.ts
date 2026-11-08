import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveQuickSessionTarget, sortProjects } from "../../web/src/lib/projects.ts";

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
