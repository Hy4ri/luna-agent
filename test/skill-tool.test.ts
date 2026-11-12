// Contract: one `skill` tool. view loads a skill; delegated children only view and list; old tool names in saved config migrate.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
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
  const imp = new SkillImprover({ skillsDir: skills, readDirs: [skills] });
  const ext = createSkillManageExtension(new SkillManager(imp, [skills]), imp, { view: { load: createSkillViewer({ dirs: [skills] }), enabled: () => true } });
  const tools = (ext as unknown as { tools: Tool[] }).tools;
  const api = { conversationId: 7, commit: async (fn: (tx: unknown) => unknown) => fn({ scanEntries: async () => ({ items: child ? [{ kind: "delegate.child" }] : [] }) }) };
  return { dir, tools, run: (args: Record<string, unknown>) => tools[0]!.execute(args, api, {}) };
};

test("skill view loads instructions and linked files", async () => {
  const { dir, tools, run } = setup(false);
  try {
    expect(tools.map(t => t.name)).toEqual(["skill"]);
    const loaded = await run({ action: "view", name: "demo" });
    expect(!loaded.isError).toBeTruthy(); expect(loaded.output[0]!.text).toMatch(/Do the demo[\s\S]*notes\.md/);
    expect((await run({ action: "view", name: "demo", file_path: "notes.md" })).output[0]!.text).toBe("linked notes");
    expect((await run({ action: "view", name: "demo", file_path: "../x" })).output[0]!.text).toMatch(/escapes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("delegated children can view and list but not change skills", async () => {
  const { dir, run } = setup(true);
  try {
    expect(!(await run({ action: "view", name: "demo" })).isError).toBeTruthy();
    expect(!(await run({ action: "list" })).isError).toBeTruthy();
    const write = await run({ action: "delete", name: "demo" });
    expect(write.isError).toBe(true); expect(write.output[0]!.text).toMatch(/not available to delegated children/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("saved configs with retired tool names load with the merged names", () => {
  const c = parseConfig({
    dataDir: "/tmp/x",
    codemode: { pinned: ["bash", "web_search", "web_extract", "skill_view", "browser_tab", "browser_inspect", "browser_act", "process"] },
    disabledTools: ["cron_history", "vision_analyze"],
    subagents: { profiles: { scout: { tools: ["read", "skill_view", "session_status"] } } },
  });
  expect(c.codemode.pinned).toEqual(["bash", "web", "skill", "browser", "browser_act", "process_manage"]);
  expect(c.disabledTools).toEqual(["cron", "media_analyze"]);
  expect(c.subagents.profiles.scout!.tools).toEqual(["read", "skill", "session_status"]);
});
