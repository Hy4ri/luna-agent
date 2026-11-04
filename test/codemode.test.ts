// Luna's integration must deliver real sandbox results without widening tool permissions.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { parseConfig } from "../src/config.js";
import { startRuntime } from "../src/runtime.js";
import { codemodeCatalog } from "../src/codemode.js";

async function runCode(code: string, disabledTools: string[] = [], toolAllowlist?: string[], timeoutMs = 5000) {
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
      ownership: { kind: "ownerless" }, agent: { model: modelRef, ...(toolAllowlist ? { toolAllowlist } : {}) },
    }, context);
    const run = await (await session.submit({ type: "input", content: "execute workflow" }, context)).wait(context);
    assert.equal(run.status, "done");
    const entries = (await session.entries({}, 50, undefined, context)).items;
    const results = entries.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult");
    assert.equal(results.length, 1);
    return results[0]!;
  } finally {
    await rt?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const text = (result: Awaited<ReturnType<typeof runCode>>) => result.content.filter(b => b.type === "text").map(b => b.text).join("\n");

test("Code Mode runs through startRuntime and delivers nested read output and audit", async () => {
  const result = await runCode('const value = await tools.read({ path: "sample.txt" }); text(value);');
  assert.equal(result.isError, false);
  assert.match(text(result), /scratch-content/);
  assert.match(JSON.stringify(result.details), /"name":"read"/);
});

test("disabled tools remain blocked inside Code Mode", async () => {
  const result = await runCode('try { text(await tools.read({ path: "sample.txt" })); } catch (e) { text(e.message); }', ["read"]);
  assert.match(text(result), /Tool "read" is disabled in settings/);
  assert.doesNotMatch(text(result), /scratch-content/);
});

test("a conversation tool allowlist also limits sandbox tool access", async () => {
  const result = await runCode('try { text(await tools.read({ path: "sample.txt" })); } catch (e) { text("BLOCKED: " + e.message); }', [], ["codemode"]);
  assert.match(text(result), /BLOCKED:/);
  assert.doesNotMatch(text(result), /scratch-content/);
});

for (const directive of ["", '// @options: {"timeout_ms": 600000}\n']) {
  test(`Luna enforces a deadline when the script ${directive ? "requests a longer one" : "omits one"}`, { timeout: 15000 }, async () => {
    const result = await runCode(`${directive}while (true) {}`, [], undefined, 100);
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out|timeout/i);
  });
}

test("pinned tools stay in the codemode catalog when cheaper tools fill the budget", () => {
  const params = { type: "object", properties: {} };
  const cheap = Array.from({ length: 20 }, (_, i) => ({ name: `cheap_${i}`, description: "x", parameters: params }));
  const bash = { name: "bash", description: "Run a command. ".repeat(40), parameters: params };
  const section = codemodeCatalog([...cheap, bash], ["bash"], 400)!;
  assert.match(section, /^### `bash`/m);
  assert.ok(section.indexOf("### `bash`") < section.indexOf("### `cheap_0`"));
  assert.match(section, /searchTools\(\)/);
});
