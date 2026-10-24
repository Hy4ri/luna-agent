// Local Chromium-family browser (Helium, Chromium, Chrome) driven through Playwright.
// Used where the browser runs on the same machine as Luna code: main, or a worker. Playwright is loaded on first use.
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import { validateWebUrl } from "./web-tools.js";
import type { BrowserImage, BrowserProvider, BrowserTab, BrowserTarget } from "./browser-tools.js";

export interface ChromiumOptions { executablePath?: string; headless: boolean }
const PAGE_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

export function createChromiumBrowserProvider(options: () => ChromiumOptions): BrowserProvider & { dispose(): Promise<void> } {
  const tabs = new Map<string, Page>();
  let context: Promise<BrowserContext> | undefined, browser: Browser | undefined;

  function launch() {
    return context ??= (async () => {
      const { executablePath, headless } = options();
      if (!executablePath) throw new Error("Set browser.providers.chromium.executablePath to a Chromium-based browser such as Helium.");
      const { chromium } = await import("playwright").catch(() => { throw new Error("Playwright is not installed. Run pnpm install on this machine."); });
      browser = await chromium.launch({ executablePath, headless });
      browser.on("disconnected", () => { browser = undefined; context = undefined; tabs.clear(); });
      return browser.newContext();
    })().catch(error => { context = undefined; throw error; });
  }
  const page = (tabId: string) => {
    const found = tabs.get(tabId);
    if (!found || found.isClosed()) throw new Error(`No open tab "${tabId}". Open a new tab.`);
    return found;
  };
  const tab = (tabId: string, p: Page): BrowserTab => ({ tabId, url: validateWebUrl(p.url()) });
  const locator = (p: Page, t: BrowserTarget) => t.ref !== undefined ? p.locator(`aria-ref=${t.ref}`) : p.locator(t.selector!);

  const provider: BrowserProvider = {
    async open({ url }, signal) {
      validateWebUrl(url); signal.throwIfAborted();
      const p = await (await launch()).newPage();
      const tabId = `tab_${randomBytes(6).toString("hex")}`;
      tabs.set(tabId, p);
      try { await p.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }); return tab(tabId, p); }
      catch (error) { tabs.delete(tabId); await p.close().catch(() => {}); throw error; }
    },
    async navigate({ tabId, url }, signal) {
      validateWebUrl(url); signal.throwIfAborted();
      const p = page(tabId);
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      return tab(tabId, p);
    },
    async close({ tabId }) { const p = tabs.get(tabId); tabs.delete(tabId); await p?.close(); },
    async snapshot({ tabId, offset }, signal) {
      signal.throwIfAborted();
      const p = page(tabId), start = offset ?? 0;
      const text = await p.ariaSnapshot({ mode: "ai" });
      if (start > text.length) throw new Error("Snapshot offset is past the end of the page.");
      const end = Math.min(text.length, start + PAGE_CHARS), hasMore = end < text.length;
      return { ...tab(tabId, p), content: text.slice(start, end), hasMore, totalChars: text.length, ...(hasMore ? { nextOffset: end } : {}) };
    },
    async click(request, signal) { signal.throwIfAborted(); await locator(page(request.tabId), request).click({ timeout: 10_000 }); },
    async type(request, signal) {
      signal.throwIfAborted();
      const target = locator(page(request.tabId), request);
      await target.fill(request.text, { timeout: 10_000 });
      if (request.pressEnter) await target.press("Enter", { timeout: 10_000 });
    },
    async scroll({ tabId, direction, amount }, signal) {
      signal.throwIfAborted();
      await page(tabId).mouse.wheel(direction === "left" ? -amount : direction === "right" ? amount : 0, direction === "up" ? -amount : direction === "down" ? amount : 0);
    },
    async screenshot({ tabId }, signal): Promise<BrowserImage> {
      signal.throwIfAborted();
      return { data: (await page(tabId).screenshot({ type: "png" })).toString("base64"), mimeType: "image/png" };
    },
  };
  return Object.assign(provider, { async dispose() { const b = browser; browser = undefined; context = undefined; tabs.clear(); await b?.close().catch(() => {}); } });
}
