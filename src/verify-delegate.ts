// Verifies delegate_task: parallel spawn, fork inheritance, list, wait/gather, steer, stop.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Delegate } from "./delegate.js";
import { context, createModels, openLuna } from "./luna.js";

const d = mkdtempSync(join(process.cwd(), ".vd-"));
const done = (code: number): never => { rmSync(d, { recursive: true, force: true }); process.exit(code); };
const fail = (m: string): never => { console.error("FAIL", m); return done(1); };
const textOf = (m: any): string =>
  typeof m?.content === "string" ? m.content : (m?.content ?? []).map((c: any) => c.text ?? "").join("");

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const harness = await openLuna({ dbPath: join(d, "luna.db"), models, cwd: d, extensions: [Delegate] });
const m = faux.getModel();
const root = await harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });

const toolCall = (args: any) => fauxAssistantMessage([fauxToolCall("delegate_task", args)], { stopReason: "toolUse" });
const childSaw: Record<string, string[]> = {};
const parentResults: string[] = [];
let ids: number[] = [];

const respond = (ctx: any) => {
  const msgs: any[] = ctx.messages;
  const last = [...msgs].reverse().find((x) => x.role === "user" || x.role === "toolResult") ?? msgs[msgs.length - 1];
  const isParent = last.role === "toolResult" || textOf(last) === "orchestrate please";
  if (!isParent) {
    const task = textOf(last);
    childSaw[task] = msgs.map(textOf);
    if (task.includes("ALPHA")) return fauxAssistantMessage([fauxText("ALPHA_RESULT")]);
    if (task.includes("BETA")) return fauxAssistantMessage([fauxText("BETA_RESULT")]);
    return fauxAssistantMessage([fauxText("child:" + task)]);
  }
  // parent: drive a script off how many tool results it has already seen
  const results = msgs.filter((x) => x.role === "toolResult");
  parentResults.splice(0, parentResults.length, ...results.map(textOf));
  const step = results.length;
  if (step >= 1) { const mm = textOf(results[step - 1]).match(/child (\d+)/); if (mm && step <= 2) ids.push(Number(mm[1])); }
  switch (step) {
    case 0: return toolCall({ action: "spawn", task: "do ALPHA" });
    case 1: return toolCall({ action: "spawn", task: "do BETA with context", fork: true });
    case 2: return toolCall({ action: "wait", timeoutSec: 20 });
    case 3: return toolCall({ action: "list" });
    case 4: return toolCall({ action: "steer", ids, task: "now do GAMMA" });
    case 5: return toolCall({ action: "wait", timeoutSec: 20 });
    default: return fauxAssistantMessage([fauxText("all gathered")]);
  }
};
faux.setResponses(Array(80).fill(respond));

// Give the fork something to inherit: seed history before delegating.
const seed = await root.submit({ type: "input", content: "SEEDCONTEXT remember the word pineapple" }, context);
await seed.wait(context);
faux.setResponses(Array(80).fill(respond));
const sub = await root.submit({ type: "input", content: "orchestrate please" }, context);
const settled = await sub.wait(context);
if (settled.status !== "done") fail("parent not done: " + JSON.stringify(settled).slice(0, 300));

console.log("--- parent tool results ---");
parentResults.forEach((r, i) => console.log(i + 1, JSON.stringify(r)));
if (ids.length !== 2) fail("expected 2 spawned ids, got " + ids);
if (!parentResults[0]!.includes("spawned child")) fail("spawn result");
if (!parentResults[1]!.includes("(forked)")) fail("fork result");
const wait1 = parentResults[2]!;
if (!wait1.includes("ALPHA_RESULT") || !wait1.includes("BETA_RESULT")) fail("wait did not gather both answers: " + wait1);
console.log("OK parallel spawn + gather (ALPHA_RESULT, BETA_RESULT)");
const beta = Object.entries(childSaw).find(([k]) => k.includes("BETA"))?.[1] ?? [];
if (!beta.some((x) => x.includes("pineapple"))) fail("forked child did not inherit parent history");
const alpha = Object.entries(childSaw).find(([k]) => k.includes("ALPHA"))?.[1] ?? [];
if (alpha.some((x) => x.includes("pineapple"))) fail("blank-slate child leaked parent history");
console.log("OK fork inherits history; plain spawn is isolated");
if (!/running|done/.test(parentResults[3]!)) fail("list output: " + parentResults[3]);
console.log("OK list");
if (!parentResults[4]!.includes("steered 2/2")) fail("steer: " + parentResults[4]);
if (!parentResults[5]!.includes("child:now do GAMMA")) fail("steered answer not gathered: " + parentResults[5]);
console.log("OK steer + re-gather");
await harness.close(context);
console.log("DELEGATE_OK");
done(0);
