import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { ProjectError, ProjectStore } from "../src/projects.js";

// The store owns migration, partial-update preservation, validation, and persistence.
// Existing conversation tests do not exercise project metadata.
test("project appearance migrates, survives reopen, validates atomically, and resets without changing project routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-project-appearance-"));
  const path = join(dir, "projects.db");
  let db = new DatabaseSync(path);
  try {
    // Legacy schema: preserve existing IDs and links while adding nullable appearance.
    db.exec(`CREATE TABLE luna_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL) STRICT;
      INSERT INTO luna_projects(id, name, cwd) VALUES (7, 'Legacy', '/directory/no-longer-present');`);
    let store = new ProjectStore(db);
    const legacy = store.get(7)!;
    assert.equal(legacy.color, null);
    assert.equal(legacy.icon, null);
    store.setWorkerDir(7, 2, "/worker/project");
    store.link(42, 7);
    const changed = store.update(7, { color: "#Aa44FF", icon: "code", favorite: true });
    assert.equal(changed.color, "#aa44ff");
    assert.equal(changed.icon, "code");
    assert.equal(changed.name, "Legacy");
    assert.equal(changed.cwd, "/directory/no-longer-present");
    assert.equal(changed.favorite, true);
    assert.deepEqual(changed.workerDirs, [{ worker: 2, cwd: "/worker/project" }]);
    assert.equal(store.projectOf(42), 7);

    db.close(); db = new DatabaseSync(path); store = new ProjectStore(db);
    assert.deepEqual(store.get(7), changed);
    assert.deepEqual(store.list().find(p => p.id === 7), changed);
    assert.equal(store.update(7, { favorite: false }).color, "#aa44ff");
    assert.equal(store.update(7, { color: null }).icon, "code");
    assert.equal(store.update(7, { color: "#123456" }).icon, "code");
    // Custom symbols are one visible grapheme, not one UTF-16 code unit.
    for (const icon of ["󱄅", "\ue0b0", "π", "A", "👩‍💻", "🇯🇴", "e\u0301", "👍🏽"]) {
      assert.equal(store.update(7, { icon }).icon, icon);
      db.close(); db = new DatabaseSync(path); store = new ProjectStore(db);
      assert.equal(store.get(7)!.icon, icon);
    }
    const before = store.get(7);
    for (const changes of [{ color: "red", icon: "folder" }, { color: "#abc" }, { color: 123 }, { color: "#112233", icon: "not-an-icon" }, { icon: {} }, ...["ab", "πλ", "", " ", "\n", "\u200d", "\u0301", "\u202e", "<svg>"].map(icon => ({ icon }))]) {
      assert.throws(() => store.update(7, changes), (e: unknown) => e instanceof ProjectError && e.status === 400);
      assert.deepEqual(store.get(7), before, "invalid updates must not partially change metadata");
    }
    assert.throws(() => store.update(0, { name: "Renamed" }), (e: unknown) => e instanceof ProjectError && e.status === 409);
    assert.throws(() => store.update(999, { color: null }), (e: unknown) => e instanceof ProjectError && e.status === 404);
    const reset = store.update(7, { icon: null, color: null });
    assert.equal(reset.icon, null);
    assert.equal(reset.color, null);
    assert.equal(reset.cwd, changed.cwd);
    assert.deepEqual(reset.workerDirs, changed.workerDirs);
    assert.equal(store.projectOf(42), 7);
    const created = store.create("New", dir);
    assert.equal(created.color, null);
    assert.equal(created.icon, null);
    store.update(created.id, { icon: "rocket", color: "#112233" });
    const renamed = store.update(created.id, { name: "Renamed", cwd: dir });
    assert.equal(renamed.icon, "rocket");
    assert.equal(renamed.color, "#112233");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Chat appearance must persist without turning General into a named/routed project.
test("General appearance persists while its routing and protected fields stay unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-chat-appearance-"));
  const path = join(dir, "projects.db");
  let db = new DatabaseSync(path);
  try {
    let store = new ProjectStore(db);
    const original = store.get(0)!;
    const custom = store.update(0, { icon: "π", color: "#Aa44FF" });
    assert.equal(custom.icon, "π");
    assert.equal(custom.color, "#aa44ff");
    assert.equal(custom.general, true);
    assert.equal(custom.name, original.name);
    assert.equal(custom.cwd, "");
    assert.equal(store.dirFor(0, null), undefined);
    assert.equal(store.dirFor(0, 2), undefined);
    assert.equal(store.projectOf(123), 0);
    db.close(); db = new DatabaseSync(path); store = new ProjectStore(db);
    assert.deepEqual(store.get(0), custom);
    assert.deepEqual(store.list().filter(p => p.id === 0), [custom]);
    assert.equal(store.update(0, { color: null }).icon, "π");
    const before = store.get(0);
    for (const changes of [{ name: "X", icon: "code" }, { cwd: dir }, { favorite: true }, { icon: "two" }, { color: "red" }]) {
      assert.throws(() => store.update(0, changes), (e: unknown) => e instanceof ProjectError);
      assert.deepEqual(store.get(0), before);
    }
    assert.throws(() => store.delete(0), (e: unknown) => e instanceof ProjectError && e.status === 409);
    assert.throws(() => store.setWorkerDir(0, 2, dir), (e: unknown) => e instanceof ProjectError && e.status === 409);
    const reset = store.update(0, { icon: null, color: null });
    assert.equal(reset.icon, null);
    assert.equal(reset.color, null);
    assert.equal(store.list().length, 1);
    assert.equal(store.create("Named", dir).id, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
