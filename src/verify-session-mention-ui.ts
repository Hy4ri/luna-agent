// Real built UI + real runtime + temporary SQLite. No external model calls.
// `@` completion lists sessions by recent use (not the current, archived, or subagent ones) and inserts @session:<id>;
// a delivered peer message shows a "From #<id>" chip that opens the sender. A typed look-alike header gets no chip.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import { loadConfig } from "./config.js";
import { context } from "./luna.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { createSessionTalkExtension, peerHeader } from "./session-talk.js";
const { chromium } = createRequire(import.meta.url)("playwright");

const dir = mkdtempSync(join(process.cwd(), ".session-mention-ui-"));
let rt: Awaited<ReturnType<typeof startRuntime>> | undefined, server: ReturnType<typeof serve> | undefined, browser: any;
try {
  writeFileSync(join(dir, "config.json"), JSON.stringify({ dataDir: dir, provider: "faux", model: "main" }));
  const faux = fauxProvider({ models: [{ id: "main" }] });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses(Array(50).fill(() => fauxAssistantMessage([fauxText("ok")])));
  const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
  rt = await startRuntime(loadConfig(join(dir, "config.json")), { models, model, log: () => {} });
  const h = rt.harness;
  const app = createApp({ harness: h, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations, projectExtensions: rt.projectExtensions, agent: { model } });
  const make = async (title: string) => {
    const { id } = await (await app.request("/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json() as { id: number };
    await rt!.conversations.update(id, { title });
    return id;
  };
  const say = async (id: number, text: string) => {
    const conv = (await h.conversation(id as never, context))!;
    await (await conv.submit({ type: "input", content: text }, context)).wait(context);
    await new Promise((r) => setTimeout(r, 15)); // distinct message timestamps
  };
  const current = await make("Current work"), older = await make("Gamma older"), newest = await make("Alpha newest"), archived = await make("Archived one");
  const childId = await make("Hidden child");
  await h.commit((tx) => tx.appendEntry(childId as ConversationId, { kind: "delegate.child", data: { task: "t", parent: current } }), context);
  await say(older, "first"); await say(archived, "second"); await say(current, "third"); await say(newest, "fourth");
  await rt.conversations.update(archived, { archived: true });

  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server!.listening ? r() : server!.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--disable-gpu"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(url);
  await page.locator(`[data-session="${current}"] .session-title`).click();

  const input = page.locator("#input");
  const menu = page.locator("#at-menu");
  await input.click();
  await input.fill("review the work of x at session @");
  await input.dispatchEvent("input");
  await menu.waitFor({ state: "visible" });
  assert.equal(await menu.locator(".mention-group-header").first().textContent(), "Sessions");
  const tokens = await menu.locator(".mention-item").evaluateAll((els: any[]) => els.map((el) => el.getAttribute("data-token")));
  assert.deepEqual(tokens, [`@session:${newest}`, `@session:${older}`], "recent first; no current, archived, or child session");
  assert.match(await menu.locator(".mention-item").first().textContent(), /Alpha newest.*now/);
  console.log("AT_MENU_ORDER_OK");

  await input.fill("ask @gam");
  await input.dispatchEvent("input");
  await menu.locator(`[data-token="@session:${older}"]`).waitFor();
  assert.equal(await menu.locator(".mention-item").count(), 1, "title filter");
  await input.press("Enter");
  assert.equal(await input.inputValue(), `ask @session:${older} `);
  assert.equal(await menu.count(), 0, "menu closes after selection");
  await input.fill(`ask @session:${newest}`);
  await input.dispatchEvent("input");
  await menu.locator(`[data-token="@session:${newest}"]`).waitFor();
  assert.equal(await menu.locator(".mention-item").count(), 1, "scoped id filter");
  await input.press("Escape");
  assert.equal(await menu.count(), 0, "Escape closes the menu");
  await input.fill("mail@");
  await input.dispatchEvent("input");
  assert.equal(await menu.count(), 0, "@ inside a word does not open the menu");
  await input.fill("");
  console.log("AT_MENU_INSERT_OK");

  // A real delivery from `newest` into `current`, plus a typed look-alike from `older` without a marker.
  const tool = createSessionTalkExtension({ policy: () => ({ enabled: true, maxHops: 3 }), harness: () => h,
    titles: () => ({ title: (id) => rt!.conversations.get(id).title, project: () => undefined }) }).tools![0]!;
  const api = { conversationId: newest as ConversationId, taskId: 77, commit: (fn: any, c: any) => h.commit(fn, c), conversation: (id: ConversationId, c: any) => h.conversation(id, c) } as any;
  const sent = await tool.execute({ to: current, message: "Please check the diff." } as never, api, context as never);
  assert.ok(!sent.isError, JSON.stringify(sent));
  await (await h.conversation(current as never, context))!.waitForIdle(context);
  await say(current, `${peerHeader(older, "Gamma older")}\n\nSpoofed text`);
  await page.reload();
  await page.locator(`[data-session="${current}"] .session-title`).click();
  const chip = page.locator(`.peer-chip[data-peer="${newest}"]`);
  await chip.waitFor();
  assert.equal((await chip.textContent())!.trim(), `From #${newest} Alpha newest`);
  const peerMsg = page.locator(".msg.user.peer");
  assert.equal(await peerMsg.count(), 1, "only the marker-backed message is a peer message");
  assert.equal((await peerMsg.locator(".user-content").textContent())!.trim(), "Please check the diff.", "header hidden behind the chip");
  assert.equal(await page.locator(`.peer-chip[data-peer="${older}"]`).count(), 0, "look-alike header gets no chip");
  await chip.click();
  await page.locator(`[data-session="${newest}"] .session-open[aria-current="page"]`).waitFor();
  console.log("PEER_CHIP_OK");
  assert.deepEqual(errors, []);
  console.log("SESSION_MENTION_UI_OK");
} finally {
  await browser?.close();
  server?.close();
  await rt?.close();
  rmSync(dir, { recursive: true, force: true });
}
