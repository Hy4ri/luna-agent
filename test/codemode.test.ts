// Luna's integration must deliver real sandbox results without widening tool permissions.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { codemodeCatalog, codemodeToolDescription, createLunaCodemodeExtension } from "../src/codemode.js";

async function runCode(code: string, disabledTools: string[] = [], enabledTools?: string[], timeoutMs = 5000) {
  const dir = mkdtempSync(join(tmpdir(), "luna-codemode-"));
  writeFileSync(join(dir, "sample.txt"), "scratch-content");
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("finished")]),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const modelRef = { provider: model.provider, modelId: model.id };
  let rt: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    rt = await startRuntime(parseConfig({ dataDir: dir, cwd: dir, extensions: ["coding", "codemode"], disabledTools, codemode: { timeoutMs } }), { models, model: modelRef });
    const session = await rt.harness.createConversation({
      ownership: { kind: "ownerless" }, agent: { model: modelRef },
      // Store the enabled-tool filter by name, as side tasks copy it from their parent.
      ...(enabledTools ? { init: async (tx, id) => { (await tx.doc(AgentDoc, id)).tools = [...enabledTools]; } } : {}),
    }, context);
    const run = await (await session.submit({ type: "input", content: "execute workflow" }, context)).wait(context);
    expect(run.status).toBe("done");
    const entries = (await session.entries({}, 50, undefined, context)).items;
    const results = entries.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    expect(results.length).toBe(1);
    return results[0]!;
  } finally {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = (result: Awaited<ReturnType<typeof runCode>>) => result.content.filter(b => b.type === "text").map(b => b.text).join("\n");

test("Code Mode runs through startRuntime and delivers nested read output and audit", async () => {
  const result = await runCode('const value = await tools.read({ path: "sample.txt" }); text(value);');
  expect(result.isError).toBe(false);
  expect(text(result)).toMatch(/scratch-content/);
  expect(JSON.stringify(result.details)).toMatch(/"name":"read"/);
});

test("disabled tools remain blocked inside Code Mode", async () => {
  const result = await runCode('try { text(await tools.read({ path: "sample.txt" })); } catch (e) { text(e.message); }', ["read"]);
  expect(text(result)).toMatch(/Tool "read" is disabled in settings/);
  expect(text(result)).not.toMatch(/scratch-content/);
});

test("the enabled tool set also limits sandbox tool access", async () => {
  const result = await runCode('try { text(await tools.read({ path: "sample.txt" })); } catch (e) { text("BLOCKED: " + e.message); }', [], ["codemode"]);
  expect(text(result)).toMatch(/BLOCKED:/);
  expect(text(result)).not.toMatch(/scratch-content/);
});

for (const directive of ["", '// @options: {"timeout_ms": 600000}\n']) {
  test(`Luna enforces a deadline when the script ${directive ? "requests a longer one" : "omits one"}`, async () => {
    const result = await runCode(`${directive}while (true) {}`, [], undefined, 100);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/timed out|timeout/i);
  }, 15000);
}

test("pinned tools stay in the codemode catalog when cheaper tools fill the budget", () => {
  const params = { type: "object", properties: {} };
  const cheap = Array.from({ length: 20 }, (_, i) => ({ name: `cheap_${i}`, description: "x", parameters: params }));
  const bash = { name: "bash", description: "Run a command. ".repeat(40), parameters: params };
  const section = codemodeCatalog([...cheap, bash], ["bash"], 400)!;
  expect(section).toMatch(/^### `bash`/m);
  expect(section.indexOf("### `bash`") < section.indexOf("### `cheap_0`")).toBeTruthy();
  expect(section).toMatch(/searchTools\(\)/);
  expect(section).not.toMatch(/^Example:/m);
});

test("the codemode section shows its example only when the session can call the tools it names", () => {
  const params = { type: "object", properties: {} };
  const tools = ["bash", "read"].map(name => ({ name, description: "x", parameters: params }));
  const section = codemodeCatalog(tools, [], 400)!;
  expect(section).toMatch(/^Example:\n```js\n/m);
  expect(section).toMatch(/split\("\\n"\)/);
  expect(section.indexOf("Example:") < section.indexOf("### `bash`")).toBeTruthy();
});

test("the codemode tool description states Luna's deadline and omits Pi features Luna does not have", () => {
  const extension = createLunaCodemodeExtension({ sandbox: {} as never, models: false }, 120_000, []);
  const description = extension.tools.find(tool => tool.name === "codemode")!.description;
  expect(description).toBe(codemodeToolDescription(120_000));
  expect(description).toMatch(/time limit is 120000 ms/);
  expect(description).not.toMatch(/namespace|models\./i);
});
