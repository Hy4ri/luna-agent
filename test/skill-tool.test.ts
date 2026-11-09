// Contract: one `skill` tool. view loads a skill; delegated children only view and list; old tool names in saved config migrate.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { parseConfig } from "../src/config.js";
import { createSkillManageExtension, SkillManager } from "../src/skill-manage.js";
import { createSkillViewer } from "../src/skills.js";
import { SkillImprover } from "../src/improve.js";

type Result = { isError?: boolean; output: { text: string }[] };
type Tool = { name: string; execute(args: Record<string, unknown>, api: unknown, ctx: unknown): Promise<Result> };

const setup = (child: boolean) => {
  const dir = mkdtempSync(join(tmpdir(), "luna-skill-tool-"));
  const skills = join(dir, "skills");
  mkdirSync(join(skills, "demo"), { recursive: true });
  writeFileSync(join(skills, "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo skill.\n---\nDo the demo.\n");
  writeFileSync(join(skills, "demo", "notes.md"), "linked notes");
  const imp = new SkillImprover({ skillsDir: skills, sources: [], readDirs: [skills] });
  const ext = createSkillManageExtension(new SkillManager(imp, [skills]), imp, { view: { load: createSkillViewer({ dirs: [skills] }), enabled: () => true } });
  const tools = (ext as unknown as { tools: Tool[] }).tools;
  const api = { conversationId: 7, commit: async (fn: (tx: unknown) => unknown) => fn({ scanEntries: async () => ({ items: child ? [{ kind: "delegate.child" }] : [] }) }) };
  return { dir, tools, run: (args: Record<string, unknown>) => tools[0]!.execute(args, api, {}) };
};

test("skill view loads instructions and linked files", async () => {
  const { dir, tools, run } = setup(false);
  try {
    assert.deepEqual(tools.map(t => t.name), ["skill"]);
    const loaded = await run({ action: "view", name: "demo" });
    assert.ok(!loaded.isError); assert.match(loaded.output[0]!.text, /Do the demo[\s\S]*notes\.md/);
    assert.equal((await run({ action: "view", name: "demo", file_path: "notes.md" })).output[0]!.text, "linked notes");
    assert.match((await run({ action: "view", name: "demo", file_path: "../x" })).output[0]!.text, /escapes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegated children can view and list but not change skills", async () => {
  const { dir, run } = setup(true);
  try {
    assert.ok(!(await run({ action: "view", name: "demo" })).isError);
    assert.ok(!(await run({ action: "list" })).isError);
    const write = await run({ action: "delete", name: "demo" });
    assert.equal(write.isError, true); assert.match(write.output[0]!.text, /not available to delegated children/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("saved configs with retired tool names load with the merged names", () => {
  const c = parseConfig({
    dataDir: "/tmp/x",
    codemode: { pinned: ["bash", "web_search", "web_extract", "skill_view"] },
    disabledTools: ["cron_history", "vision_analyze"],
    subagents: { profiles: { scout: { tools: ["read", "skill_view", "session_handoff"] } } },
  });
  assert.deepEqual(c.codemode.pinned, ["bash", "web", "skill"]);
  assert.deepEqual(c.disabledTools, ["cron", "media_analyze"]);
  assert.deepEqual(c.subagents.profiles.scout!.tools, ["read", "skill", "session_handoff"]);
});
