// Assistant-message attachments: real runtime, HTTP, SQLite, and browser. Only model responses are scripted.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { context } from "./luna.js";
import { parseConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { entryMedia, mediaDirectives } from "./media-directives.js";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || "playwright");

// Parser: order, quoting, code spans and fences are text, SVG is never inline.
assert.deepEqual(mediaDirectives('a MEDIA:/x/a.png b MEDIA:"sp ace.pdf" `MEDIA:/etc/passwd`\n```\nMEDIA:/etc/shadow\n```\nMEDIA:z.svg').map(d => [d.raw, d.type]),
  [["/x/a.png", "image"], ["sp ace.pdf", "document"], ["z.svg", "document"]]);
assert.deepEqual(entryMedia([{ role: "user", content: "MEDIA:/u.png" }, { role: "assistant", content: [{ type: "text", text: "MEDIA:/a.png" }, { type: "thinking", thinking: "MEDIA:/t.png" }, { type: "text", text: "MEDIA:/b.zip" }] }]).map(d => [d.raw, d.message, d.block]),
  [["/a.png", 1, 0], ["/b.zip", 1, 2]]);

const dir = mkdtempSync(join(tmpdir(), "luna-attachments-"));
const work = join(dir, "work"); mkdirSync(work);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64");
const zip = Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31 + 7) & 255));
writeFileSync(join(dir, "pixel.png"), png);
writeFileSync(join(work, "report data.zip"), zip);
symlinkSync(join(dir, "pixel.png"), join(work, "link.png"));
const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
const fm = faux.getModel(), model = { provider: fm.provider, modelId: fm.id };
const rt = await startRuntime(parseConfig({ dataDir: dir, cwd: work, extensions: [] }, dir, {}), { models, model, log: () => {} });
const app = createApp({ harness: rt.harness, models, sideCommands: rt.sideCommands, conversations: rt.conversations, agent: { model }, token: "test" });
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once("listening", r));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const get = (path: string, auth = true) => fetch(origin + path, { headers: auth ? { authorization: "Bearer test" } : {} });
let browser: any;
try {
  const conv = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: work } }, context);
  const other = await rt.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model, cwd: work } }, context);
  faux.setResponses([fauxAssistantMessage(`Before the image\nMEDIA:${join(dir, "pixel.png")}\nBetween attachments\nMEDIA:"report data.zip"\nAfter the file\nMEDIA:gone.pdf\nMEDIA:link.png\nEnd`)]);
  await (await conv.submit({ type: "input", content: "Send files MEDIA:/etc/hostname" }, context)).wait(context);
  const entries = (await conv.entries({}, 10, undefined, context)).items;
  const answer = entries.find(e => e.model?.[0]?.role === "assistant")!, question = entries.find(e => e.model?.[0]?.role === "user")!;
  const base = `/v1/sessions/${conv.id}/entries/${answer.id}/media`;

  // HTTP: exact bytes, MIME, auth, conversation scope, index bounds, user text ignored, explicit file errors.
  let r = await get(`${base}/0`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png"); assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
  r = await get(`${base}/1`);
  assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "application/zip"); assert.equal(r.headers.get("content-length"), String(zip.length));
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), zip);
  assert.equal((await get(`${base}/0`, false)).status, 401);
  assert.equal((await get(base.replace(`/sessions/${conv.id}/`, `/sessions/${other.id}/`) + "/0")).status, 404, "entry must belong to the session");
  assert.equal((await get(`${base}/4`)).status, 404);
  assert.equal((await get(`/v1/sessions/${conv.id}/entries/${question.id}/media/0`)).status, 404, "user text is never served");
  r = await get(`${base}/2`); assert.equal(r.status, 404); assert.match((await r.json() as any).error, /^file not found$/);
  r = await get(`${base}/3`); assert.equal(r.status, 404); assert.match((await r.json() as any).error, /^symlinks are not served$/);

  // Browser: inline placement, image load, download bytes, missing file, reload, mobile layout.
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process", "--disable-gpu"] });
  // --single-process Chromium cannot open a second page; one page changes viewport instead.
  const page = await browser.newPage({ acceptDownloads: true }); page.setDefaultTimeout(12000);
  const errors: string[] = []; page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.addInitScript((id: string) => { localStorage.setItem("luna.token", "test"); localStorage.setItem("luna.session", id); }, String(conv.id));
  for (const viewport of [{ width: 1200, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const load of ["goto", "reload"]) {
      if (load === "goto") await page.goto(origin); else await page.reload();
      const msg = page.locator(`.msg.assistant[data-entry="${answer.id}"]`);
      await msg.locator("img.att").waitFor();
      await page.waitForFunction((id: number) => { const img = (globalThis as any).document.querySelector(`.msg.assistant[data-entry="${id}"] img.att`); return img?.complete && img.naturalWidth === 1; }, answer.id);
      const order = await msg.evaluate((el: any) => [...el.children].filter((c: any) => !c.matches(".msg-footer, footer")).map((c: any) =>
        c.classList.contains("attachment") ? `att:${c.dataset.attachment}` : c.textContent.trim()).filter(Boolean));
      assert.deepEqual(order.slice(0, 7), ["Before the image", "att:image", "Between attachments", "att:document", "After the file", "att:document", "att:image"], `inline order ${JSON.stringify(order)}`);
      const card = msg.locator(".att-file").filter({ hasText: "report data.zip" });
      await card.getByText("68.4 KB").waitFor();
      await msg.locator(".att-missing").filter({ hasText: "gone.pdf" }).filter({ hasText: "file not found" }).waitFor();
      await msg.locator(".att-missing").filter({ hasText: "symlinks are not served" }).waitFor();
      assert.equal(await page.locator('.msg.user .attachment').count(), 0, "user messages keep MEDIA text as text");
      const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("link", { name: "Download report data.zip" }).click()]);
      assert.equal(download.suggestedFilename(), "report data.zip");
      assert.deepEqual(readFileSync(await download.path()), zip, "downloaded bytes match");
      const box = await card.boundingBox(), width = await page.evaluate(() => (globalThis as any).document.getElementById("log").clientWidth);
      assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.width <= width, `file card fits ${viewport.width}px`);
    }
  }
  assert.deepEqual(errors, []);
  console.log("ATTACHMENTS_OK: inline image + file card, exact download bytes, session scope, symlink/missing errors, reload, mobile");
} finally {
  await browser?.close(); await new Promise<void>(r => server.close(() => r())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
