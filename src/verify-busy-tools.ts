import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { context, createModels, openLuna } from "./luna.js";
import { createApp } from "./server.js";
const dir = mkdtempSync(join(tmpdir(), "luna-busy-tools-"));
const release = join(dir, "release"), started = join(dir, "started"), finished = join(dir, "finished");
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
const harness = await openLuna({ models, dbPath: join(dir, "db"), cwd: dir, memory: false });
const app = createApp({ harness, agent: { model } });
const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Background process test timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const post = async (content: string) => {
  const response = await app.request(`/v1/sessions/${conv.id}/messages?async=1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  assert.equal(response.status, 202, await response.clone().text()); return response.json() as Promise<any>;
};
try {
  let processId: string | undefined;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("bash", { command: `echo $$ > '${started}'; printf 'begun'; while [ ! -f '${release}' ]; do sleep 0.05; done; echo $$ > '${finished}'; printf 'completed'` })], { stopReason: "toolUse" }),
    ctx => {
      const text = ctx.messages.filter(m => m.role === "toolResult").flatMap(m => m.content).flatMap(b => b.type === "text" ? [b.text] : []).join("\n");
      processId = /Process ID: ([a-f0-9-]+)/.exec(text)?.[1];
      assert.ok(processId, text); assert.ok(!existsSync(finished));
      return fauxAssistantMessage([fauxToolCall("process_manage", { action: "read", id: processId })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("Correction handled while command runs"),
    fauxAssistantMessage("Background result handled"),
  ]);
  const first = await post("start command");
  await until(() => existsSync(started));
  await until(async () => (await harness.snapshot(LiveDoc, conv.id, context))?.tools?.some(tool => tool.output?.includes("begun")) ?? false);
  const correction = await post("Change direction"); assert.equal(correction.action, "steered");
  const original = await harness.submission(first.submissionId, context); assert.ok(original);
  assert.equal((await original.wait(context)).status, "done"); assert.ok(processId); assert.ok(!existsSync(finished), "Foreground wait must yield before process exits");
  const foreign = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("process_manage", { action: "read", id: processId })], { stopReason: "toolUse" }), ctx => {
    const result = ctx.messages.findLast(m => m.role === "toolResult");
    assert.ok(result?.role === "toolResult" && result.isError, "Background process handles must remain session-scoped");
    return fauxAssistantMessage("Foreign process refused");
  }, fauxAssistantMessage("Background result handled")]);
  const foreignSub = await foreign.submit({ type: "input", content: "inspect foreign process" }, context); await foreignSub.wait(context);
  writeFileSync(release, "go"); await until(() => existsSync(finished));
  assert.equal(readFileSync(started, "utf8"), readFileSync(finished, "utf8"), "Yield must retain the same live OS process");
  await until(async () => (await conv.entries({ order: "ascending" }, 100, undefined, context)).items.some(e => e.kind === "pi.user" && e.model?.some(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("Background process ") && m.content.includes("completed"))));
  await conv.waitForIdle(context);
  console.log("BUSY_TOOLS_OK: foreground wait yields, same OS process survives, output retained, completion follows up, process handles session-scoped");
} finally { writeFileSync(release, "go"); await harness.close(context); rmSync(dir, { recursive: true, force: true }); }
