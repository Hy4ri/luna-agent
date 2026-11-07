// Local browsers driven through Playwright: Chromium-family (Helium, Chromium, Chrome) and any CDP engine such as Moli.
// Used where the browser runs on the same machine as Luna code: main, or a worker. Playwright is loaded on first use.
import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import { validateWebUrl } from "./web-tools.js";
import type { BrowserImage, BrowserInput, BrowserProvider, BrowserTab, BrowserTarget } from "./browser-tools.js";

export interface ChromiumOptions { executablePath?: string; headless: boolean }
/** How a Playwright-driven engine is started and stopped. `prepare` runs before snapshots and pointer, keyboard and scroll actions. */
export interface PlaywrightEngine {
  start(): Promise<{ browser: Browser; context: BrowserContext }>;
  stop?(): Promise<void>;
  prepare?(page: Page): Promise<void>;
}
const PAGE_CHARS = 20_000;
const TIMEOUT_MS = 30_000;

export function createChromiumBrowserProvider(options: () => ChromiumOptions): BrowserProvider & { dispose(): Promise<void> } {
  return createPlaywrightBrowserProvider({
    async start() {
      const { executablePath, headless } = options();
      if (!executablePath) throw new Error("Set browser.providers.chromium.executablePath to a Chromium-based browser such as Helium.");
      const { chromium } = await import("playwright").catch(() => { throw new Error("Playwright is not installed. Run pnpm install on this machine."); });
      const browser = await chromium.launch({ executablePath, headless });
      return { browser, context: await browser.newContext() };
    },
  });
}

export function createPlaywrightBrowserProvider(engine: PlaywrightEngine): BrowserProvider & { dispose(): Promise<void> } {
  const tabs = new Map<string, Page>();
  let context: Promise<BrowserContext> | undefined, browser: Browser | undefined;

  function launch() {
    return context ??= (async () => {
      const started = await engine.start();
      browser = started.browser;
      browser.on("disconnected", () => { browser = undefined; context = undefined; tabs.clear(); void engine.stop?.(); });
      return started.context;
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
      await engine.prepare?.(p);
      const text = await p.ariaSnapshot({ mode: "ai" });
      if (start > text.length) throw new Error("Snapshot offset is past the end of the page.");
      const end = Math.min(text.length, start + PAGE_CHARS), hasMore = end < text.length;
      return { ...tab(tabId, p), content: text.slice(start, end), hasMore, totalChars: text.length, ...(hasMore ? { nextOffset: end } : {}) };
    },
    async click(request, signal) {
      signal.throwIfAborted();
      const p = page(request.tabId); await engine.prepare?.(p);
      await locator(p, request).click({ timeout: 10_000 });
    },
    async type(request, signal) {
      signal.throwIfAborted();
      const p = page(request.tabId); await engine.prepare?.(p);
      const target = locator(p, request);
      await target.fill(request.text, { timeout: 10_000 });
      if (request.pressEnter) await target.press("Enter", { timeout: 10_000 });
    },
    async scroll({ tabId, direction, amount }, signal) {
      signal.throwIfAborted();
      await engine.prepare?.(page(tabId));
      await page(tabId).mouse.wheel(direction === "left" ? -amount : direction === "right" ? amount : 0, direction === "up" ? -amount : direction === "down" ? amount : 0);
    },
    async screenshot({ tabId }, signal): Promise<BrowserImage> {
      signal.throwIfAborted();
      return { data: (await page(tabId).screenshot({ type: "png" })).toString("base64"), mimeType: "image/png" };
    },
  };
  // Live frames come from CDP screencast, so only Chromium-family engines get them. Others throw and the panel polls screenshots.
  provider.watch = async ({ tabId, maxWidth, maxHeight }, onFrame, signal) => {
    const p = page(tabId);
    const cdp = await p.context().newCDPSession(p);
    const done = new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      signal.addEventListener("abort", () => resolve(), { once: true });
      p.once("close", () => resolve());
    });
    cdp.on("Page.screencastFrame", frame => {
      onFrame({ data: Buffer.from(frame.data, "base64"), width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight, url: p.url() });
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
    });
    try {
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth, maxHeight, everyNthFrame: 1 });
      await done;
    } finally {
      await cdp.send("Page.stopScreencast").catch(() => {});
      await cdp.detach().catch(() => {});
    }
  };
  provider.input = async ({ tabId, event }: { tabId: string; event: BrowserInput }) => {
    const p = page(tabId);
    if (event.kind === "mouse") {
      await p.mouse.move(event.x, event.y);
      if (event.type === "down") await p.mouse.down({ button: event.button ?? "left", clickCount: event.clickCount ?? 1 });
      else if (event.type === "up") await p.mouse.up({ button: event.button ?? "left", clickCount: event.clickCount ?? 1 });
    } else if (event.kind === "wheel") {
      await p.mouse.move(event.x, event.y);
      await p.mouse.wheel(event.deltaX, event.deltaY);
    } else if (event.kind === "key") {
      await (event.type === "down" ? p.keyboard.down(event.key) : p.keyboard.up(event.key));
    } else if (event.action === "goto") {
      const url = validateWebUrl(event.url ?? "");
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
    } else if (event.action === "back") await p.goBack({ timeout: TIMEOUT_MS });
    else if (event.action === "forward") await p.goForward({ timeout: TIMEOUT_MS });
    else await p.reload({ timeout: TIMEOUT_MS });
    return event.kind === "nav" ? { url: p.url() } : undefined;
  };
  return Object.assign(provider, { async dispose() {
    const b = browser; browser = undefined; context = undefined; tabs.clear();
    await b?.close().catch(() => {}); await engine.stop?.();
  } });
}
