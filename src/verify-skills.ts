// Verifies the skills extension: scan, prompt catalog, on-demand load, linked files, tool mounting.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { context, createModels, openLuna } from "./luna.js";
import { scanSkills, parseFrontmatter } from "./skills.js";

const fail = (m: string): never => { console.error("FAIL", m); process.exit(1); };
const d = mkdtempSync(join(process.cwd(), ".vs-"));
try {
  const sk = join(d, "skills");
  mkdirSync(join(sk, "alpha", "refs"), { recursive: true });
  mkdirSync(join(sk, "beta"));
  writeFileSync(join(sk, "alpha", "SKILL.md"), '---\nname: alpha\ndescription: "Does alpha things"\ntools: [secret_tool]\n---\n# Alpha\nUse ALPHA_MARKER.\n');
  writeFileSync(join(sk, "alpha", "refs", "r.md"), "REF_CONTENT");
  writeFileSync(join(sk, "beta", "SKILL.md"), "---\ndescription: Beta skill\n---\nBeta body\n");
  writeFileSync(join(d, "secret.txt"), "nope");

  // unit: parsing
  const fm = parseFrontmatter("---\nname: x\ntools:\n  - a\n  - b\n---\nbody");
  if (JSON.stringify(fm.data.tools) !== '["a","b"]' || fm.body !== "body") fail("frontmatter list parse");
  const scanned = scanSkills([sk]);
  if (scanned.map((s) => s.name).join() !== "alpha,beta") fail("scan names: " + scanned.map((s) => s.name));
  console.log("OK scan + frontmatter");

  const secret = defineExtension({
    name: "secret",
    tools: [defineTool({
      name: "secret_tool", description: "A deferred tool mounted by the alpha skill", parameters: Type.Object({}), deferred: true, replay: "safe",
      async execute() { return { output: [{ type: "text", text: "secret ok" }] }; },
    })],
  });

  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath: join(d, "luna.db"), models, cwd: d, skillDirs: [sk], extensions: [secret] });
  const m = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });

  const seen: { sys: string; tools: string[]; toolResults: string[] }[] = [];
  const snap = (c: any) => {
    const msgs: any[] = c.messages ?? [];
    const sys = msgs.filter((x) => x.role === "system").map((x) => JSON.stringify([x.content, x.sections ?? {}])).join("\n");
    const tools = new Set<string>();
    for (const x of msgs) if (x.role === "system") {
      for (const t of x.toolsAdded ?? []) tools.add(t.name);
      for (const t of x.toolsRemoved ?? []) tools.delete(typeof t === "string" ? t : t.name);
    }
    seen.push({ sys, tools: [...tools], toolResults: msgs.filter((x) => x.role === "toolResult").map((x) => JSON.stringify(x.content)) });
  };
  faux.setResponses([
    (c: any) => { snap(c); return fauxAssistantMessage([fauxToolCall("skill_view", { name: "alpha" })], { stopReason: "toolUse" }); },
    (c: any) => { snap(c); return fauxAssistantMessage([fauxToolCall("skill_view", { name: "alpha", file_path: "refs/r.md" }), fauxToolCall("skill_view", { name: "alpha", file_path: "../../secret.txt" })], { stopReason: "toolUse" }); },
    (c: any) => { snap(c); return fauxAssistantMessage([fauxText("done")]); },
  ]);
  const sub = await root.submit({ type: "input", content: "do alpha" }, context);
  const settled: any = await sub.wait(context);
  if (settled.status !== "done") fail("not done " + JSON.stringify(settled).slice(0, 300));
  await root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), context);
  await harness.close(context);

  if (seen.length !== 3) fail("expected 3 model calls, got " + seen.length);
  const [s0, s1, s2] = seen as [typeof seen[0], typeof seen[0], typeof seen[0]];
  if (!s0.sys.includes("alpha: Does alpha things") || !s0.sys.includes("beta: Beta skill")) fail("catalog missing from system prompt: " + s0.sys.slice(0, 400));
  if (s0.sys.includes("ALPHA_MARKER")) fail("skill body leaked before load");
  console.log("OK system prompt catalog (bodies not preloaded)");
  if (!s1.toolResults.join().includes("ALPHA_MARKER") || !s1.toolResults.join().includes("refs/r.md")) fail("skill load result: " + s1.toolResults.join().slice(0, 300));
  console.log("OK on-demand load returns body + linked files");
  if (s0.tools.includes("secret_tool")) fail("deferred tool offered before load");
  if (!s1.tools.includes("secret_tool")) fail("tool not mounted after skill load; tools=" + s1.tools);
  console.log("OK skill mounted deferred tool into registry (tools: " + s1.tools.join(",") + ")");
  const last = s2.toolResults.join();
  if (!last.includes("REF_CONTENT")) fail("linked file read: " + last.slice(0, 300));
  if (last.includes("nope") || !last.includes("escapes")) fail("path traversal not blocked: " + last.slice(0, 300));
  console.log("OK linked file read; traversal blocked");
  console.log("ALL_OK");
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
