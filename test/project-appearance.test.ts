import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test, expect } from "bun:test";
import { ProjectError, ProjectStore } from "../src/projects.js";
import { throwsWith } from "./support/expect-error.js";

// The store owns migration, partial-update preservation, validation, and persistence.
// Existing conversation tests do not exercise project metadata.
test("project appearance migrates, survives reopen, validates atomically, and resets without changing project routing", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-project-appearance-"));
  const path = join(dir, "projects.db");
  let db = new Database(path);
  try {
    // Legacy schema: preserve existing IDs and links while adding nullable appearance.
    db.exec(`CREATE TABLE luna_projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL) STRICT;
      INSERT INTO luna_projects(id, name, cwd) VALUES (7, 'Legacy', '/directory/no-longer-present');`);
    let store = new ProjectStore(db);
    const legacy = store.get(7)!;
    expect(legacy.color).toBe(null);
    expect(legacy.icon).toBe(null);
    store.setWorkerDir(7, 2, "/worker/project");
    store.link(42, 7);
    const changed = store.update(7, { color: "#Aa44FF", icon: "code", favorite: true });
    expect(changed.color).toBe("#aa44ff");
    expect(changed.icon).toBe("code");
    expect(changed.name).toBe("Legacy");
    expect(changed.cwd).toBe("/directory/no-longer-present");
    expect(changed.favorite).toBe(true);
    expect(changed.workerDirs).toStrictEqual([{ worker: 2, cwd: "/worker/project" }]);
    expect(store.projectOf(42)).toBe(7);

    db.close(); db = new Database(path); store = new ProjectStore(db);
    expect(store.get(7)).toStrictEqual(changed);
    expect(store.list().find(p => p.id === 7)).toStrictEqual(changed);
    expect(store.update(7, { favorite: false }).color).toBe("#aa44ff");
    expect(store.update(7, { color: null }).icon).toBe("code");
    expect(store.update(7, { color: "#123456" }).icon).toBe("code");
    // Custom symbols are one visible grapheme, not one UTF-16 code unit.
    for (const icon of ["󱄅", "\ue0b0", "π", "A", "👩‍💻", "🇯🇴", "e\u0301", "👍🏽"]) {
      expect(store.update(7, { icon }).icon).toBe(icon);
      db.close(); db = new Database(path); store = new ProjectStore(db);
      expect(store.get(7)!.icon).toBe(icon);
    }
    const before = store.get(7);
    for (const changes of [{ color: "red", icon: "folder" }, { color: "#abc" }, { color: 123 }, { color: "#112233", icon: "not-an-icon" }, { icon: {} }, ...["ab", "πλ", "", " ", "\n", "\u200d", "\u0301", "\u202e", "<svg>"].map(icon => ({ icon }))]) {
      throwsWith(() => store.update(7, changes), (e: unknown) => e instanceof ProjectError && e.status === 400);
      expect(store.get(7), "invalid updates must not partially change metadata").toStrictEqual(before);
    }
    throwsWith(() => store.update(0, { name: "Renamed" }), (e: unknown) => e instanceof ProjectError && e.status === 409);
    throwsWith(() => store.update(999, { color: null }), (e: unknown) => e instanceof ProjectError && e.status === 404);
    const reset = store.update(7, { icon: null, color: null });
    expect(reset.icon).toBe(null);
    expect(reset.color).toBe(null);
    expect(reset.cwd).toBe(changed.cwd);
    expect(reset.workerDirs).toStrictEqual(changed.workerDirs);
    expect(store.projectOf(42)).toBe(7);
    const created = store.create("New", dir);
    expect(created.color).toBe(null);
    expect(created.icon).toBe(null);
    store.update(created.id, { icon: "rocket", color: "#112233" });
    const renamed = store.update(created.id, { name: "Renamed", cwd: dir });
    expect(renamed.icon).toBe("rocket");
    expect(renamed.color).toBe("#112233");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Chat appearance must persist without turning General into a named/routed project.
test("General appearance persists while its routing and protected fields stay unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-chat-appearance-"));
  const path = join(dir, "projects.db");
  let db = new Database(path);
  try {
    let store = new ProjectStore(db);
    const original = store.get(0)!;
    const custom = store.update(0, { icon: "π", color: "#Aa44FF" });
    expect(custom.icon).toBe("π");
    expect(custom.color).toBe("#aa44ff");
    expect(custom.general).toBe(true);
    expect(custom.name).toBe(original.name);
    expect(custom.cwd).toBe("");
    expect(store.dirFor(0, null)).toBe(undefined);
    expect(store.dirFor(0, 2)).toBe(undefined);
    expect(store.projectOf(123)).toBe(0);
    db.close(); db = new Database(path); store = new ProjectStore(db);
    expect(store.get(0)).toStrictEqual(custom);
    expect(store.list().filter(p => p.id === 0)).toStrictEqual([custom]);
    expect(store.update(0, { color: null }).icon).toBe("π");
    const before = store.get(0);
    for (const changes of [{ name: "X", icon: "code" }, { cwd: dir }, { favorite: true }, { icon: "two" }, { color: "red" }]) {
      throwsWith(() => store.update(0, changes), (e: unknown) => e instanceof ProjectError);
      expect(store.get(0)).toStrictEqual(before);
    }
    throwsWith(() => store.delete(0), (e: unknown) => e instanceof ProjectError && e.status === 409);
    throwsWith(() => store.setWorkerDir(0, 2, dir), (e: unknown) => e instanceof ProjectError && e.status === 409);
    const reset = store.update(0, { icon: null, color: null });
    expect(reset.icon).toBe(null);
    expect(reset.color).toBe(null);
    expect(store.list().length).toBe(1);
    expect(store.create("Named", dir).id).toBe(1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
