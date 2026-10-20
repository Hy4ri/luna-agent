// Verifies skill_list / skill_manage through the wired runtime (startRuntime + faux model): listing with write
// authority, create, edits, linked files, recoverable deletion + restore, invalid input/path rejection, nested managed
// skills, and that the prompt catalog refreshes on the next model call.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";

const ok = (m: string) => console.log("OK", m);
const d = mkdtempSync(join(process.cwd(), ".vsm-"));
const skill = (name: string, body = `# ${name}\nInstructions for ${name}, long enough to pass lint.\n`) =>
  `---\nname: ${name}\ndescription: The ${name} skill for verification\n---\n${body}`;
try {
  const data = join(d, "data"), ext = join(d, "ext"), managed = join(data, "skills");
  mkdirSync(join(ext, "outside"), { recursive: true });
  writeFileSync(join(ext, "outside", "SKILL.md"), skill("outside"));
  mkdirSync(join(managed, "design", "slides"), { recursive: true });
  writeFileSync(join(managed, "design", "SKILL.md"), skill("design"));
  writeFileSync(join(managed, "design", "slides", "SKILL.md"), skill("slides"));
  writeFileSync(join(d, "secret.txt"), "SECRET");

  const cfg = parseConfig({ dataDir: data, cwd: d, skillDirs: [ext], extensions: ["coding", "skills"] }, d, {});
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const fm = faux.getModel();
  const model = { provider: fm.provider, modelId: fm.id };
  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  const root = await rt.harness.root(context, { agent: { model } });
  const offered = (await root.agent(context)).tools.map((t) => t.name);
  for (const t of ["skill_view", "skill_list", "skill_manage"]) assert.ok(offered.includes(t), `missing ${t}: ${offered.join(",")}`);
  ok("runtime offers skill_view, skill_list, skill_manage with only the skills extension");

  const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join(""));
  const catalogs: string[] = [], results: string[] = [];
  let lastId = "";
  type Args = Record<string, any>;
  type Call = [string, Args | (() => Args)];
  const calls: Call[] = [
    ["skill_list", {}],                                                                                     // 0
    ["skill_manage", { action: "create", name: "gamma", content: skill("gamma", "# Gamma\nUse GAMMA_V1 always here.\n") }], // 1
    ["skill_manage", { action: "edit", name: "gamma", old_text: "GAMMA_V1", new_text: "GAMMA_V2" }],        // 2
    ["skill_manage", { action: "write_file", name: "gamma", file_path: "refs/a.md", content: "A_ONE" }],    // 3
    ["skill_manage", { action: "write_file", name: "gamma", file_path: "refs/a.md", content: "A_TWO" }],    // 4
    ["skill_view", { name: "gamma", file_path: "refs/a.md" }],                                              // 5
    ["skill_manage", { action: "delete_file", name: "gamma", file_path: "refs/a.md" }],                     // 6
    ["skill_manage", { action: "delete", name: "gamma" }],                                                  // 7
    ["skill_list", { include_deleted: true }],                                                              // 8
    ["skill_manage", () => ({ action: "restore", id: lastId })],                                            // 9
    ["skill_manage", { action: "edit", name: "outside", content: skill("outside", "# changed body text here\n") }], // 10
    ["skill_manage", { action: "write_file", name: "gamma", file_path: "../../../secret.txt", content: "x" }], // 11
    ["skill_manage", { action: "write_file", name: "gamma", file_path: "SKILL.md", content: "x" }],          // 12
    ["skill_manage", { action: "write_file", name: "gamma", file_path: ".hidden/x.md", content: "x" }],      // 13
    ["skill_manage", { action: "create", name: "outside", content: skill("outside") }],                     // 14
    ["skill_manage", { action: "delete", name: "design" }],                                                 // 15
    ["skill_manage", { action: "write_file", name: "design", file_path: "slides/notes.md", content: "x" }], // 16
    ["skill_manage", { action: "write_file", name: "gamma", file_path: "link/x.md", content: "x" }],        // 17 (symlink)
    ["skill_manage", { action: "restore", id: "nope" }],                                                    // 18
    ["skill_manage", { action: "create", name: "Bad/Name", content: skill("Bad/Name") }],                   // 19
    ["skill_manage", { action: "create", name: "delta", content: "no frontmatter" }],                       // 20
    ["skill_manage", { action: "edit", name: "slides", old_text: "Instructions for slides", new_text: "SLIDES_V2 for slides" }], // 21
    ["skill_manage", { action: "edit", name: "gamma" }],                                                    // 22
    ["skill_manage", () => ({ action: "restore", id: /restore with id (\S+)/.exec(results[6] ?? "")![1]! })], // 23
    ["skill_view", { name: "gamma", file_path: "refs/a.md" }],                                              // 24
  ];
  let step = 0;
  const respond = (c: any) => {
    const msgs: any[] = c.messages ?? [];
    let cat = "";
    for (const x of msgs) if (x.role === "system") { const s = JSON.stringify([x.content, x.sections ?? {}]); if (s.includes("Skills are reusable")) cat = s; }
    catalogs[step] = cat;
    const tr = msgs.filter((x) => x.role === "toolResult");
    if (tr.length) results[tr.length - 1] = textOf(tr.at(-1));
    const m = /restore with id (\S+)/.exec(results.at(-1) ?? "");
    if (m) lastId = m[1]!;
    if (step === 17) symlinkSync(d, join(managed, "gamma", "link"));
    const call = calls[step++];
    if (!call) return fauxAssistantMessage([fauxText("done")]);
    const args = typeof call[1] === "function" ? call[1]() : call[1];
    return fauxAssistantMessage([fauxToolCall(call[0], args)], { stopReason: "toolUse" });
  };
  faux.setResponses(Array(calls.length + 1).fill(respond));
  const s = await (await root.submit({ type: "input", content: "manage skills" }, context)).wait(context);
  assert.equal(s.status, "done", JSON.stringify(s).slice(0, 300));
  const r = (i: number) => results[i] ?? "";

  assert.match(r(0), /outside \[external, read-only\]/); assert.match(r(0), /design \[managed\]/); assert.match(r(0), /slides \[managed\]/);
  ok("skill_list: managed vs external read-only");
  assert.match(r(1), /"applied": true/); assert.match(r(1), /lint only, no benchmark/);
  assert.ok(!catalogs[1]!.includes("gamma") && catalogs[2]!.includes("gamma: The gamma skill"), "catalog refresh after create");
  ok("create applied (reported as lint only); catalog lists gamma on the next call");
  assert.match(r(2), /"applied": true/); assert.match(r(2), /"version": 1/);
  assert.ok(readFileSync(join(managed, ".history", "gamma", "v1.md"), "utf8").includes("GAMMA_V1"));
  ok("edit old_text/new_text applied with v1 backup");
  assert.match(r(3), /Wrote .*refs\/a\.md$/); assert.match(r(4), /previous version in trash as \S+/); assert.equal(r(5), "A_TWO");
  ok("write_file creates, replace keeps old version in trash, skill_view reads new content");
  assert.match(r(6), /Deleted gamma\/refs\/a\.md; restore with id/);
  assert.match(r(7), /Deleted skill gamma; restore with id/);
  assert.ok(!catalogs[8]!.includes("gamma: The gamma"), "catalog should drop deleted skill");
  assert.match(r(8), /Deleted \(restorable\):[\s\S]*skill gamma \(deleted/); assert.match(r(8), /file gamma\/refs\/a\.md \(replaced/);
  ok("delete_file and delete go to trash; catalog drops gamma; skill_list include_deleted shows entries");
  assert.match(r(9), /Restored skill gamma/);
  assert.ok(catalogs[10]!.includes("gamma: The gamma skill"), "catalog after restore");
  assert.ok(readFileSync(join(managed, "gamma", "SKILL.md"), "utf8").includes("GAMMA_V2"));
  ok("restore brings gamma back (with its edit) and the catalog lists it again");
  assert.match(r(10), /read-only/); assert.equal(readFileSync(join(ext, "outside", "SKILL.md"), "utf8"), skill("outside"));
  assert.match(r(11), /escapes the skill directory/); assert.equal(readFileSync(join(d, "secret.txt"), "utf8"), "SECRET");
  assert.match(r(12), /SKILL\.md is not a linked file/);
  assert.match(r(13), /may not start with '\.'/);
  assert.match(r(14), /already exists/);
  assert.match(r(15), /contains nested skills \(slides\/SKILL\.md\)/); assert.ok(existsSync(join(managed, "design", "SKILL.md")));
  assert.match(r(16), /inside the nested skill at slides/);
  assert.match(r(17), /through a symlink/); assert.ok(!existsSync(join(d, "x.md")));
  assert.match(r(18), /no trash entry/);
  assert.match(r(19), /invalid skill name/);
  assert.match(r(20), /lint failed/);
  assert.match(r(22), /edit needs content, or old_text \+ new_text/);
  ok("rejected: external edit, traversal, SKILL.md, hidden path, duplicate create, nested delete, nested-owned file, symlink, bad id, bad name, lint, empty edit");
  assert.match(r(21), /"applied": true/);
  assert.ok(readFileSync(join(managed, "design", "slides", "SKILL.md"), "utf8").includes("SLIDES_V2"), "nested skill edited in place");
  assert.ok(!existsSync(join(managed, "slides")), "no shadow copy at <managed>/slides");
  assert.match(r(23), /Restored file gamma\/refs\/a\.md/); assert.equal(r(24), "A_TWO");
  ok("deleted linked file restored by id");
  ok("nested managed skill edited in place (no invisible shadow copy)");

  await rt.close();
  console.log("SKILL_MANAGE_OK");
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
