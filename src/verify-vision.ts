import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { parseConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";

const dir = mkdtempSync(join(tmpdir(), "luna-vision-routes-"));
const fixture = await sharp({ create: { width: 120, height: 80, channels: 3, background: "red" } }).png().toBuffer();
const image_url = `data:image/png;base64,${fixture.toString("base64")}`;
const args = { image_url, question: "Read the label" };
let serial = 0;
async function setup(image: boolean, vision: object = {}, aux = false, api = "anthropic-messages") {
  const main = fauxProvider({ api, provider: "main-test", models: [{ id: "main", input: image ? ["text", "image"] : ["text"] }] });
  const auxiliary = fauxProvider({ api: "anthropic-messages", provider: "aux-test", models: [{ id: "vision", input: ["text", "image"] }] });
  const models = createModels(); models.setProvider(main.provider); models.setProvider(auxiliary.provider);
  const model = { provider: "main-test", modelId: "main" };
  const cfg = parseConfig({ dataDir: join(dir, String(++serial)), extensions: [], vision,
    ...(aux ? { auxiliary: { vision: { provider: "aux-test", model: "vision" } } } : {}) }, dir, {});
  const rt = await startRuntime(cfg, { models, model, log: () => {} });
  let conversation: Awaited<ReturnType<typeof rt.harness.createConversation>> | undefined;
  let run = 0;
  async function invoke(calls: object[] = [args], child = false, input?: any, reuse = false) {
    let messages: readonly Message[] = [];
    run++;
    main.setResponses([
      fauxAssistantMessage(calls.map((a, i) => fauxToolCall("vision_analyze", a as any, { id: `call-${run}-${i}` })), { stopReason: "toolUse" }),
      c => { messages = c.messages; return fauxAssistantMessage("done"); },
    ]);
    const conv = reuse && conversation ? conversation : await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model },
      ...(child ? { init: async (tx: any, id: any) => { await tx.appendEntry(id, { kind: "delegate.child", data: { parent: 1 } }); } } : {}) }, context);
    conversation = conv;
    await (await conv.submit({ type: "input", content: input ?? "Inspect image" }, context)).wait(context);
    const results = messages.filter(m => m.role === "toolResult").slice(-calls.length);
    assert.equal(results.length, calls.length, JSON.stringify(messages));
    return results.map(result => {
      const blocks = result.content;
      const raw = blocks.filter(b => b.type === "text").map(b => b.text).join("");
      let data; try { data = JSON.parse(raw); } catch { data = { error: raw }; }
      return { data, images: blocks.filter(b => b.type === "image"), error: result.isError };
    });
  }
  async function offered() {
    let names: string[] = [];
    main.setResponses([c => { const tools = new Set<string>(); for (const m of c.messages) if (m.role === "system") { for (const t of m.toolsAdded ?? []) tools.add(t.name); for (const t of m.toolsRemoved ?? []) tools.delete(t.name); } names = [...tools]; return fauxAssistantMessage("done"); }]);
    const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    await (await conv.submit({ type: "input", content: "List tools" }, context)).wait(context);
    return names.includes("vision_analyze");
  }
  return { rt, main, auxiliary, invoke, offered, models, cfg };
}
try {
  const defaults = parseConfig({}, dir, {});
  assert.equal(defaults.vision.long_edge, 2048); assert.equal(defaults.vision.history_budget_bytes, 262144);
  assert.equal(defaults.vision.hard_bytes, 1048576); assert.equal(defaults.vision.max_calls_per_image, 0);
  assert.equal(defaults.vision.subagent_max_calls_per_image, 3);
  assert.throws(() => parseConfig({ auxiliary: { vision: { model: "x" } } }, dir, {}));
  assert.throws(() => parseConfig({ vision: { hard_bytes: -1 } }, dir, {}));
  assert.throws(() => parseConfig({ vision: { unknown: true } }, dir, {}));
  {
    const s = await setup(false);
    try { assert.equal(await s.offered(), false); } finally { await s.rt.close(); }
  }
  {
    const s = await setup(true);
    try {
      assert.equal(await s.offered(), true);
      const [r] = await s.invoke(); assert.equal(r!.data.route, "native"); assert.equal(r!.images.length, 1);
      assert.ok(r!.images[0]!.data.length <= 262144);
      assert.equal((await s.invoke([{ ...args, region: { x: 0.5, y: 0, width: 10, height: 10 } }]))[0]!.error, true);
      const crop = { x: 0, y: 0, width: 40, height: 40 };
      const rs = await s.invoke([args, args, { ...args, region: crop }]);
      assert.equal(rs[0]!.data.success, true); assert.equal(rs[1]!.data.skipped, true); assert.equal(rs[2]!.data.success, true);
      const variants = await s.invoke([{ ...args, region: crop }, { ...args, region: { height: 40, width: 40, y: 0, x: 0 } }]);
      assert.equal(variants[1]!.data.skipped, true, "region property order cannot bypass duplicate detection");
      const [attached] = await s.invoke([args], false, [{ type: "text", text: "Inspect attached" }, { type: "image", data: fixture.toString("base64"), mimeType: "image/png" }]);
      assert.equal(attached!.data.skipped, true);
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(true, { profiles: { "main-test": { tool_result_images: false } } });
    try {
      const [failure] = await s.invoke(); assert.equal(failure!.data.success, false); assert.deepEqual(failure!.data.retry, { use_active_model: true });
      const [retry] = await s.invoke([{ ...args, use_active_model: true }]); assert.equal(retry!.images.length, 1);
    } finally { await s.rt.close(); }
  }
  for (const [native, vision] of [[false, {}], [true, { image_mode: "auxiliary" }], [true, { profiles: { "main-test": { tool_result_images: false } } }]] as const) {
    const s = await setup(native, vision, true);
    try {
      assert.equal(await s.offered(), true);
      s.auxiliary.setResponses([(c, o) => {
        assert.equal(o?.temperature, 0.1); assert.equal(o?.timeoutMs, 120000);
        const user = c.messages.findLast(m => m.role === "user")!;
        assert.ok(Array.isArray(user.content));
        assert.equal(user.content.find(b => b.type === "text")?.text, "Fully describe everything, then answer: Read the label");
        assert.equal(user.content.find(b => b.type === "image")?.data, fixture.toString("base64"));
        return fauxAssistantMessage("The label is red.");
      }]);
      const [r] = await s.invoke(); assert.deepEqual(r!.data, { success: true, analysis: "The label is red." }); assert.equal(r!.images.length, 0);
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(false, {}, true);
    try {
      s.auxiliary.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("Recovered")]);
      assert.equal((await s.invoke())[0]!.data.analysis, "Recovered"); assert.equal(s.auxiliary.state.callCount, 2);
      let resized = false;
      s.auxiliary.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Image size exceeds limit" }), c => {
        const user = c.messages.findLast(m => m.role === "user")!;
        const image = typeof user.content === "string" ? undefined : user.content.find(b => b.type === "image");
        assert.ok(image?.type === "image"); resized = image.data !== fixture.toString("base64");
        return fauxAssistantMessage("Smaller image read");
      }]);
      assert.equal((await s.invoke())[0]!.data.success, true); assert.equal(resized, true);
      s.auxiliary.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
      assert.match((await s.invoke())[0]!.data.error, /empty/i);
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(true, {}, true);
    try {
      const get = s.models.getModel.bind(s.models);
      s.models.getModel = (provider, id) => {
        const model = get(provider, id);
        if (provider !== "main-test" || !model) return model;
        // Native capability succeeds for gate and throws only on provider API inspection.
        return new Proxy(model, { get(target, key, receiver) { if (key === "api") throw new Error("Capability lookup failed"); return Reflect.get(target, key, receiver); } });
      };
      s.auxiliary.setResponses([fauxAssistantMessage("Fallback works")]);
      // Models needs the real catalog model for generation. Throw through profiles instead.
      s.models.getModel = get;
      Object.defineProperty(s.cfg.vision.profiles, "main-test/main", { get() { throw new Error("profile error"); } });
      assert.equal((await s.invoke())[0]!.data.analysis, "Fallback works");
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(false, {}, true);
    try {
      s.auxiliary.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("Seen")));
      const rs = await s.invoke([0, 1, 2, 3].map(x => ({ ...args, region: { x, y: 0, width: 30, height: 30 } })), true);
      assert.ok(rs.slice(0, 3).every(r => r.data.success)); assert.match(rs[3]!.data.error, /limit/i);
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(true);
    try {
      assert.equal((await s.invoke())[0]!.images.length, 1);
      assert.equal((await s.invoke([args], false, undefined, true))[0]!.images.length, 1, "new user entry starts a new turn");
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(false, {}, true);
    try {
      s.auxiliary.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("Seen")));
      const crops = [0, 1, 2, 3].map(x => ({ ...args, region: { x, y: 0, width: 30, height: 30 } }));
      assert.ok((await s.invoke(crops)).every(r => r.data.success), "main agent has no default cap");
      s.auxiliary.setResponses(Array.from({ length: 3 }, () => fauxAssistantMessage("Seen")));
      assert.ok((await s.invoke(crops.slice(0, 2), true)).every(r => r.data.success));
      const second = await s.invoke(crops.slice(2), true, undefined, true);
      assert.equal(second[0]!.data.success, true); assert.match(second[1]!.data.error, /limit/i, "crop count persists across turns");
    } finally { await s.rt.close(); }
  }
  {
    const s = await setup(true, { hard_bytes: 1 });
    try { const [r] = await s.invoke(); assert.equal(r!.error, true); assert.match(r!.data.error, /budget|limit/); assert.equal(r!.images.length, 0); }
    finally { await s.rt.close(); }
  }
  {
    const s = await setup(false, {}, true);
    try {
      const before = new Set(readdirSync(tmpdir()).filter(n => n.startsWith("luna-vision-")));
      let entered!: () => void; const ready = new Promise<void>(r => { entered = r; }); let cancelled = false;
      s.auxiliary.setResponses([async (_c, options) => {
        entered(); await new Promise<void>(r => options!.signal!.addEventListener("abort", () => { cancelled = true; r(); }, { once: true }));
        return fauxAssistantMessage("", { stopReason: "aborted" });
      }]);
      s.main.setResponses([fauxAssistantMessage([fauxToolCall("vision_analyze", args)], { stopReason: "toolUse" })]);
      const conv = await s.rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "main-test", modelId: "main" } } }, context);
      const submission = await conv.submit({ type: "input", content: "Inspect" }, context);
      await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("auxiliary did not start")), 5000).unref())]);
      await conv.abort(context); await submission.wait(context);
      assert.equal(cancelled, true, "durable interruption reaches auxiliary request");
      assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith("luna-vision-") && !before.has(n)), [], "interrupted analysis cleans its private files");
    } finally { await s.rt.close(); }
  }
  console.log("VISION_OK");
} finally { rmSync(dir, { recursive: true, force: true }); }
