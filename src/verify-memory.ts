// Verifies memory store semantics, compaction, and end-to-end tool + prompt-section + cross-session persistence.
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { context, createModels, openLuna, MemoryStore } from "./luna.js";

const d = mkdtempSync(join(process.cwd(), ".vmem-"));
try {
  // --- store unit checks
  const s = new MemoryStore(join(d, "u.db"), { maxNotes: 8, budget: 600 });
  const a = s.remember({ key: "user.tz", content: "Asia/Amman" });
  const b = s.remember({ key: "user.tz", content: "UTC+3" });
  assert.equal(a.id, b.id); assert.equal(s.recall("tz").length, 1); assert.equal(s.recall("tz")[0]!.content, "UTC+3");
  assert.throws(() => s.remember({ kind: "fact", content: "x" }));
  assert.throws(() => s.remember({ content: "  " }));
  for (let i = 0; i < 12; i++) s.remember({ content: `note tok${String(i).padStart(2,"0")}x about 100% sure_thing`, tags: ["T"] });
  const live = s.recall("", { kind: "note", limit: 50 });
  assert.ok(live.length <= 8 && live.length >= 6, "live notes capped: " + live.length);
  assert.ok(s.recall("tok00x", { includeArchived: true }).some((r) => r.archived), "archived still searchable");
  assert.equal(s.recall("tok00x").length, 0, "archived hidden by default");
  assert.equal(s.recall("100% sure_thing", { limit: 50 }).length, live.length, "LIKE escapes % and _");
  const out = s.render()!;
  assert.ok(out.length <= 600 + 80, "render within budget: " + out.length);
  assert.ok(out.includes("user.tz: UTC+3") && out.includes("Older notes (digest)") && out.includes("tok11x"));
  assert.ok(s.forget(a.id) && !s.forget(a.id));
  s.close();
  console.log("OK store: upsert, validation, compaction, escaping, budget, forget");

  // --- end to end: session 1 remembers via tool; session 2 (new harness, new faux) sees it in the system prompt
  const dir = join(d, "e2e"); mkdirSync(dir);
  const run = async (responses: any[], prompt: string) => {
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    const store = new MemoryStore(join(dir, "memory.db"));
    const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, cwd: dir, memory: store });
    const m = faux.getModel();
    const root = await harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });
    let sys = "";
    faux.setResponses(responses.map((r) => (typeof r === "function" ? r : r)));
    const sub = await root.submit({ type: "input", content: prompt }, context);
    const settled: any = await sub.wait(context);
    assert.equal(settled.status, "done");
    await root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), context);
    await harness.close(context); store.close();
    return faux;
  };
  const f1 = await run([
    fauxAssistantMessage([fauxToolCall("remember", { key: "m57.printer", content: "HP M111w at 192.168.1.37" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("saved")]),
  ], "remember my printer");
  const chk = new MemoryStore(join(dir, "memory.db"));
  assert.equal(chk.recall("printer")[0]?.content, "HP M111w at 192.168.1.37");
  chk.close();
  console.log("OK tool: remember wrote through the harness");

  let seen = "";
  const f2 = await run([
    (ctx: any) => { seen = JSON.stringify(ctx); return fauxAssistantMessage([fauxText("ok")]); },
  ], "what printer?");
  assert.ok(seen.includes("m57.printer") && seen.includes("192.168.1.37"), "memory section injected into prompt in new session");
  console.log("OK injection: new session's prompt contains stored fact");
} finally {
  rmSync(d, { recursive: true, force: true });
}
process.exit(0);
