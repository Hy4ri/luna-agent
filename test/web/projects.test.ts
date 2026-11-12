// Web modules use bundler resolution, so this folder is excluded from the root tsc project; typecheck:web covers them.
import { test, expect } from "bun:test";
import { resolveQuickSessionTarget, resolveSnapProject, sortProjects } from "../../web/src/lib/projects.ts";

test("sortProjects places favourites first and keeps relative order inside each group", () => {
  const input = [
    { name: "alpha", favorite: false },
    { name: "beta", favorite: true },
    { name: "gamma", favorite: false },
    { name: "delta", favorite: true },
  ];
  expect(sortProjects(input).map(p => p.name)).toEqual(["beta", "delta", "alpha", "gamma"]);
});

test("resolveQuickSessionTarget defaults to main host for Chats, General, or main-host projects", () => {
  const projects = [
    { id: 0, general: true, cwd: "" },
    { id: 1, cwd: "/home/m57/Projects/luna-pi", workerDirs: [{ worker: 2, cwd: "/srv/luna-pi" }] },
  ];
  const workers = [{ id: 2, name: "arm-worker", online: true }];

  expect(resolveQuickSessionTarget(null, "Chats", projects, workers)).toEqual({ worker: null });
  expect(resolveQuickSessionTarget(0, "General", projects, workers)).toEqual({ worker: null });
  expect(resolveQuickSessionTarget(1, "luna-pi", projects, workers)).toEqual({ worker: null });
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

  expect(resolveQuickSessionTarget(5, "remote-only", projects, workers)).toEqual({ worker: 11 });
});

test("resolveQuickSessionTarget disables quick-new with a clear reason when no linked machine is online", () => {
  const projects = [
    { id: 6, cwd: "", workerDirs: [{ worker: 10, cwd: "/srv/offline-box" }] },
    { id: 7, cwd: "", workerDirs: [] },
  ];
  const workers = [{ id: 10, name: "box-a", online: false }];

  expect(resolveQuickSessionTarget(6, "remote-only", projects, workers)).toEqual({
    worker: 10,
    disabledReason: "box-a is offline",
  });
  expect(resolveQuickSessionTarget(7, "unlinked", projects, workers)).toEqual({
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
  expect(resolveSnapProject(snapProjects, "2", 5)).toBe(2);
  expect(resolveSnapProject(snapProjects, "0", 5)).toBe(0);
});

test("resolveSnapProject defaults to luna-pi when no valid saved project exists", () => {
  expect(resolveSnapProject(snapProjects, null, 2)).toBe(5);
  expect(resolveSnapProject(snapProjects, "", 0)).toBe(5);
  expect(resolveSnapProject(snapProjects, "999", 2)).toBe(5);
  expect(resolveSnapProject(snapProjects, "not-a-number", 2)).toBe(5);
});

test("resolveSnapProject falls back to active project or first project when luna-pi is absent", () => {
  const withoutLunaPi = [
    { id: 0, name: "General" },
    { id: 2, name: "hermes-mobile" },
  ];
  expect(resolveSnapProject(withoutLunaPi, null, 2)).toBe(2);
  expect(resolveSnapProject(withoutLunaPi, "999", null)).toBe(0);
  expect(resolveSnapProject([], null, 2)).toBe(2);
  expect(resolveSnapProject([], null, null)).toBe(null);
});
