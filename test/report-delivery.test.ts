// Contract: automatic reports reach an active run after its current tool, not after its final answer.
// Existing delegation tests collect with wait; they do not exercise automatic delivery to a busy parent.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { context, openLuna } from "../src/luna.js";
import { Children, DELEGATE_CHILD } from "../src/delegate-state.js";
import { Crew, CrewLead } from "../src/crew-state.js";
import { CrewNotifier } from "../src/session-crew.js";
import { SubagentNotifier } from "../src/subagent-notify.js";

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const kind of ["subagent", "crew"] as const) {
  test(`${kind} reports steer active work once, before the next model request`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "luna-report-"));
    const entered = signal();
    const release = signal();
    const faux = fauxProvider({ models: [{ id: "parent" }, { id: "child" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    let calls = 0;
    let nextContext = "";
    faux.setResponses(Array.from({ length: 8 }, () => (request, _options, _state, model) => {
      if (model.id === "child") return fauxAssistantMessage([fauxText("REPORT_SENTINEL")]);
      if (calls++ === 0) return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
      if (calls === 2) nextContext = JSON.stringify(request.messages);
      return fauxAssistantMessage([fauxText("parent finished")]);
    }));
    const gate = defineExtension({ name: "report-gate", tools: [defineTool({
      name: "hold", description: "Hold current work.", parameters: Type.Object({}),
      execute: async () => {
        entered.resolve();
        await release.promise;
        return { output: [{ type: "text", text: "work continued" }] };
      },
    })] });
    const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false, coding: false, extensions: [gate] });
    const notifier = kind === "crew"
      ? new CrewNotifier({ harness, log() {}, title: () => null })
      : new SubagentNotifier({ harness, log() {} });
    try {
      const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.provider.id, modelId: "parent" } } }, context);
      const child = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: faux.provider.id, modelId: "child" } } }, context);
      await harness.commit(async tx => {
        if (kind === "crew") {
          (await tx.doc(Crew, parent.id)).members.push({ id: Number(child.id), spawnKey: "spawn", task: "report", requests: ["child-task"] });
          (await tx.doc(CrewLead, child.id)).lead = Number(parent.id);
        } else {
          (await tx.doc(Children, parent.id)).children.push({ id: Number(child.id), spawnKey: "spawn", task: "report", requests: ["child-task"], notify: true });
          await tx.appendEntry(child.id, { kind: DELEGATE_CHILD, data: { parent: Number(parent.id) } });
        }
      }, context);
      await (await child.submit({ type: "input", content: "report", requestId: "child-task" }, context)).wait(context);
      const run = await parent.submit({ type: "input", content: "keep working" }, context);
      await entered.promise;
      assert.equal(await notifier.notify(Number(child.id)), true, "report must be admitted while the parent tool is active");
      await notifier.notify(Number(child.id)); // Stable request IDs must prevent duplicate delivery.
      release.resolve();
      assert.equal((await run.wait(context)).status, "done");
      assert.match(nextContext, /REPORT_SENTINEL/, "the first model request after the tool must include the report");
      const entries = (await parent.entries({}, 100, undefined, context)).items;
      assert.equal(entries.filter(e => e.kind === "luna.xsession.msg").length, 1);
    } finally {
      release.resolve();
      await notifier.close();
      await harness.close(context);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
}

// A FIFO gives the real shell process an event-driven completion gate; no timing sleeps.
test("background process output reaches the next active model request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-process-report-"));
  const fifo = join(dir, "output.fifo");
  const mkfifo = Bun.spawnSync(["mkfifo", fifo]);
  if (!mkfifo.success) throw new Error(mkfifo.stderr.toString() || "mkfifo failed");
  const entered = signal();
  const release = signal();
  const delivered = signal();
  const faux = fauxProvider();
  const model = faux.getModel();
  const models = createModels();
  models.setProvider(faux.provider);
  let calls = 0, nextContext = "";
  faux.setResponses(Array.from({ length: 8 }, () => request => {
    switch (calls++) {
      case 0: return fauxAssistantMessage([fauxToolCall("bash", { command: `cat '${fifo}'`, background: true })], { stopReason: "toolUse" });
      case 1: return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
      case 2: nextContext = JSON.stringify(request.messages);
    }
    return fauxAssistantMessage([fauxText("parent finished")]);
  }));
  const gate = defineExtension({ name: "process-gate", tools: [defineTool({
    name: "hold", description: "Hold current work.", parameters: Type.Object({}),
    execute: async () => {
      entered.resolve();
      await release.promise;
      return { output: [{ type: "text", text: "work continued" }] };
    },
  })] });
  const harness = await openLuna({ dbPath: join(dir, "luna.db"), models, memory: false,
    cwd: dir, extensions: [gate], processes: { enabled: true, retentionHours: 1, maxOutputBytes: 1024 },
    processNotify: async () => { delivered.resolve(); },
  });
  try {
    const parent = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, context);
    const run = await parent.submit({ type: "input", content: "start background work and continue" }, context);
    await entered.promise;
    await writeFile(fifo, "PROCESS_REPORT_SENTINEL");
    await delivered.promise;
    release.resolve();
    assert.equal((await run.wait(context)).status, "done");
    assert.match(nextContext, /PROCESS_REPORT_SENTINEL/, "completion must reach the model before its final answer");
  } finally {
    release.resolve();
    await harness.close(context);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
