// Verifies single-turn execution and crash resumption against a scripted faux model.
// Modes: `tsx src/verify.ts` (orchestrator) | child modes `crash` / `resume`.
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { context, createModels, openLuna } from "./luna.js";

const [mode, dir] = process.argv.slice(2);

async function setup(dbPath: string, cwd: string) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await openLuna({ dbPath, models, cwd });
  const m = faux.getModel();
  const root = await harness.root(context, { agent: { model: { provider: m.provider, modelId: m.id } } });
  return { faux, harness, root };
}

async function finish(root: any, sub: any) {
  const settled = await sub.wait(context);
  if (settled.status !== "done" || settled.type !== "input") throw new Error("submission not done: " + JSON.stringify(settled).slice(0, 300));
  const e = await root.commit((tx: any) => tx.entry(AssistantEntry, settled.answer), context);
  return JSON.stringify(e?.model?.[0]).slice(0, 300);
}

if (!mode) {
  const d = mkdtempSync(join(process.cwd(), ".verify-"));
  const fail = (m: string): never => { console.error("FAIL", m); process.exit(1); };
  try {
    // 1. single turn with a real bash tool call
    const a = join(d, "a"); 
    const { mkdirSync } = await import("node:fs"); mkdirSync(a);
    const t1 = await setup(join(a, "luna.db"), a);
    t1.faux.setResponses([
      fauxAssistantMessage([fauxToolCall("bash", { command: "echo hello > out.txt" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done turn one")]),
    ]);
    const s1 = await t1.root.submit({ type: "input", content: "write a file" }, context);
    console.log("single-turn answer:", await finish(t1.root, s1));
    await t1.harness.close(context);
    if (readFileSync(join(a, "out.txt"), "utf8").trim() !== "hello") fail("bash tool did not write file");
    console.log("OK single turn: bash tool executed, file written");

    // 2. crash: child starts a long bash call, gets SIGKILLed mid-tool; second child resumes
    const b = join(d, "b"); mkdirSync(b);
    const run = (m: string) => spawn(process.execPath, ["--import", "tsx", "src/verify.ts", m, b], { stdio: ["ignore", "pipe", "inherit"] });
    const c1 = run("crash");
    await new Promise<void>((res) => {
      c1.stdout!.on("data", (x) => { if (String(x).includes("TOOL_STARTED")) { c1.kill("SIGKILL"); res(); } });
      c1.on("exit", () => res());
    });
    await new Promise((r) => setTimeout(r, 200));
    if (!existsSync(join(b, "luna.db"))) fail("no luna.db after crash");
    console.log("OK crashed child SIGKILLed mid-tool; luna.db persisted");
    const c2 = run("resume");
    let out = ""; c2.stdout!.on("data", (x) => (out += x));
    const code = await new Promise<number | null>((r) => c2.on("exit", r));
    process.stdout.write(out);
    if (code !== 0 || !out.includes("RESUMED_OK")) fail("resume failed, exit " + code);
    console.log("OK crash resumption");
    rmSync(d, { recursive: true, force: true });
    process.exit(0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
} else if (mode === "crash") {
  const { faux, root } = await setup(join(dir!, "luna.db"), dir!);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: "echo started > started.txt; sleep 60" })], { stopReason: "toolUse" }),
  ]);
  await root.submit({ type: "input", content: "long job", requestId: "job-1" }, context);
  const poll = setInterval(() => { if (existsSync(join(dir!, "started.txt"))) { console.log("TOOL_STARTED"); clearInterval(poll); } }, 50);
  await new Promise(() => {});
} else if (mode === "resume") {
  const { faux, harness, root } = await setup(join(dir!, "luna.db"), dir!);
  // after restart the interrupted tool call is closed out; model gets the next generation
  faux.setResponses([fauxAssistantMessage([fauxText("recovered after crash")])]);
  const sub = await root.submit({ type: "input", content: "long job", requestId: "job-1" }, context); // same id => existing submission
  harness.resume();
  console.log("answer:", await finish(root, sub));
  await harness.close(context);
  console.log("RESUMED_OK");
  process.exit(0);
}
