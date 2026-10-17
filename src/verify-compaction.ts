// Deterministic runtime checks. No real provider requests.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { CompactionTask, LiveDoc, UserEntry, AssistantEntry, defineExtension, defineTool, hook } from "@earendil-works/pi-durable";
import { context, createModels, openLuna } from "./luna.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function within<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Compaction gate timed out")), 8000); })]); }
  finally { clearTimeout(timer!); }
}
const dir = mkdtempSync(join(tmpdir(), "luna-compaction-"));
try {
  for (const scenario of ["tools", "sequential", "final", "disabled", "overflow", "abort", "restart", "failure"] as const) {
    const faux = fauxProvider({ models: [{ id: "main", contextWindow: 4000 }] });
    const models = createModels(); models.setProvider(faux.provider);
    const m = faux.getModel(), model = { provider: m.provider, modelId: m.id };
    const toolStarts = [gate(), gate()], toolReleases = [gate(), gate()], toolEnds = [gate(), gate()];
    const compactStart = gate(), compactRelease = gate();
    const reasons: string[] = [];
    const extension = defineExtension({
      name: "compaction-test",
      tools: [defineTool({
        name: "gated", ...(scenario === "sequential" ? { executionMode: "sequential" as const } : {}), description: "A controlled test tool", parameters: Type.Object({ index: Type.Integer() }),
        async execute(args) {
          const i = args.index;
          toolStarts[i]!.resolve(); await toolReleases[i]!.promise;
          toolEnds[i]!.resolve(); return { output: [{ type: "text", text: "T".repeat(2800) }] };
        },
      })],
      hooks: [hook(CompactionTask, {
        async beforeCompact(compaction) {
          reasons.push(compaction.reason); compactStart.resolve();
          if (scenario === "failure") return undefined;
          if (scenario === "abort" || scenario === "restart") return undefined;
          await compactRelease.promise;
          return { summary: "Earlier work was completed. Continue the current task." };
        },
      })],
    });
    const options = {
      dbPath: join(dir, scenario + ".db"), models, memory: false as const, coding: false, extensions: [extension],
      compaction: () => ({ enabled: true, autoEnabled: scenario !== "disabled" && scenario !== "overflow", triggerPercent: 75, backgroundTokens: 0 }),
    };
    const harness = await openLuna(options);
    try {
      const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
      // Old history fits below the trigger, but supplies a real removable prefix.
      await conv.commit(async tx => {
        await tx.appendEntry(UserEntry, conv.id, { model: [{ role: "user", content: "old ".repeat(scenario === "overflow" ? 500 : 1800), timestamp: 1 }] });
        await tx.appendEntry(AssistantEntry, conv.id, { model: [fauxAssistantMessage(scenario === "overflow" ? "earlier ".repeat(800) : "Earlier reply")] });
      }, context);
      const toolAnswer = fauxAssistantMessage([fauxToolCall("gated", { index: 0 }), fauxToolCall("gated", { index: 1 })], { stopReason: "toolUse" });
      const finalAnswer = fauxAssistantMessage("Final answer ".repeat(550));
      let summaryOptions: any;
      if (scenario === "tools" || scenario === "sequential") faux.setResponses([toolAnswer, fauxAssistantMessage("Resumed answer")]);
      else if (scenario === "overflow") faux.setResponses([
        fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: context window exceeded" }), fauxAssistantMessage("Recovered answer"),
      ]);
      else if (scenario === "abort" || scenario === "restart") faux.setResponses([finalAnswer, async (_ctx, options) => {
        summaryOptions = options;
        await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return fauxAssistantMessage("aborted summary");
      }]);
      else if (scenario === "failure") faux.setResponses([finalAnswer, (_ctx, options) => {
        summaryOptions = options;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request: summary refused" });
      }]);
      else faux.setResponses([finalAnswer]);
      const sub = await conv.submit({ type: "input", content: "Continue the task" }, context);
      let settled = false;
      const completion = sub.wait(context).then(result => { settled = true; return result; });
      if (scenario === "tools" || scenario === "sequential") {
        await within(scenario === "sequential" ? toolStarts[0]!.promise : Promise.all(toolStarts.map(g => g.promise)).then(() => {}));
        assert.equal(reasons.length, 0, "Never compact while tools run");
        toolReleases[0]!.resolve(); await within(toolEnds[0]!.promise);
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(reasons.length, 0, "Wait for every parallel tool");
        if (scenario === "sequential") await within(toolStarts[1]!.promise);
        toolReleases[1]!.resolve();
        await within(compactStart.promise);
        assert.equal(faux.state.callCount, 1, "No next generation before compaction");
        assert.equal(settled, false);
        assert.ok((await harness.snapshot(LiveDoc, conv.id, context))?.compactions?.some(c => c.blocking));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(faux.state.callCount, 1, "Generation stays paused during summary");
        compactRelease.resolve();
      } else if (scenario === "final" || scenario === "overflow") {
        await within(compactStart.promise);
        assert.equal(settled, false, "Final boundary waits for compaction");
        assert.equal(faux.state.callCount, 1);
        compactRelease.resolve();
      } else if (scenario === "abort" || scenario === "restart") {
        await within(compactStart.promise);
        // Let the summarizer request start, so abort exercises owned-task cancellation.
        while (!summaryOptions) await new Promise(resolve => setTimeout(resolve, 5));
        if (scenario === "restart") {
          const closedWait = completion.catch(error => error);
          await harness.close(context);
          assert.match(String(await closedWait), /Harness is closed/);
          faux.setResponses([fauxAssistantMessage("Recovered summary")]);
          const reopened = await openLuna(options);
          try {
            const resumed = await reopened.submission(sub.id, context); assert.ok(resumed);
            reopened.resume();
            assert.equal((await within(resumed.wait(context))).status, "done");
            const resumedConv = await reopened.conversation(conv.id, context); assert.ok(resumedConv);
            await resumedConv.waitForIdle(context);
            assert.ok((await resumedConv.context(context)).head);
            assert.equal(faux.state.callCount, 3, "Only the summary retries; the final answer does not regenerate");
            assert.equal((await reopened.snapshot(LiveDoc, conv.id, context))?.run, undefined);
            console.log("OK compaction: restart");
          } finally { await reopened.close(context); }
          continue;
        }
        await within(conv.abort(context));
      }
      const result = await within(completion);
      await conv.waitForIdle(context);
      if (scenario === "abort") assert.equal(result.status, "unanswered");
      else assert.equal(result.status, "done", JSON.stringify(result));
      const live = await harness.snapshot(LiveDoc, conv.id, context);
      assert.equal(live?.run, undefined); assert.equal(live?.compactions, undefined);
      if (scenario === "tools" || scenario === "sequential") {
        assert.ok(reasons.length >= 1 && reasons.every(reason => reason === "threshold")); assert.equal(faux.state.callCount, 2);
        assert.ok((await conv.context(context)).head, "Summary must enter active context");
      } else if (scenario === "final") {
        assert.deepEqual(reasons, ["threshold"]); assert.equal(faux.state.callCount, 1, "No invented turn after final answer");
        assert.ok((await conv.context(context)).head);
      } else if (scenario === "disabled") {
        assert.deepEqual(reasons, []); assert.equal(faux.state.callCount, 1);
      } else if (scenario === "overflow") {
        assert.deepEqual(reasons, ["overflow"]); assert.equal(faux.state.callCount, 2, "Overflow recovers even with auto disabled");
      } else if (scenario === "failure") {
        assert.ok(live?.compactionFailure, "Surface summary failure without dropping final answer");
        assert.equal(faux.state.callCount, 2);
        assert.ok(summaryOptions.maxTokens <= 1000, "Small-window summary output stays within budget");
      }
      console.log("OK compaction:", scenario);
    } finally {
      toolReleases.forEach(g => g.resolve()); compactRelease.resolve();
      await harness.close(context);
    }
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("COMPACTION_OK");
