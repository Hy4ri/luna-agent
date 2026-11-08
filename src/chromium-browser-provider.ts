// Local browsers driven through Playwright: Chromium-family (Helium, Chromium, Chrome) and any CDP engine such as Moli.
// Used where the browser runs on the same machine as Luna code: main, or a worker. Playwright is loaded on first use.
import { stat } from "node:fs/promises";
import type { Browser, BrowserContext, Dialog, Page } from "playwright";
import { validateWebUrl } from "./web-tools.js";
import type { BrowserDialog, BrowserImage, BrowserInput, BrowserLogs, BrowserProvider, BrowserTab, BrowserTarget } from "./browser-tools.js";

export interface ChromiumOptions { cdpUrl?: string; executablePath?: string; headless: boolean }
/** How a Playwright-driven engine is started and stopped. `prepare` runs before snapshots and pointer, keyboard and scroll actions. */
export interface PlaywrightEngine {
  start(): Promise<{ browser: Browser; context: BrowserContext }>;
  stop?(): Promise<void>;
  prepare?(page: Page): Promise<void>;
}
const PAGE_CHARS = 20_000;
const TIMEOUT_MS = 30_000;
const ACTION_MS = 10_000;
const MAX_LOG = 100;
/** What a page did that Luna cannot see in a snapshot. */
interface PageState { logs: BrowserLogs; unseen: BrowserDialog[]; arm?: { accept: boolean; promptText?: string } }
const keep = <T>(list: T[], item: T) => { list.push(item); if (list.length > MAX_LOG) list.shift(); };

export function createChromiumBrowserProvider(options: () => ChromiumOptions): BrowserProvider & { dispose(): Promise<void> } {
  return createPlaywrightBrowserProvider({
    async start() {
      const { cdpUrl, executablePath, headless } = options();
      const { chromium } = await import("playwright").catch(() => { throw new Error("Playwright is not installed. Run bun install on this machine."); });
      if (cdpUrl) {
        const browser = await chromium.connectOverCDP(cdpUrl).catch((error: Error) => {
          throw new Error(`No browser answers at ${cdpUrl}. Start it with --remote-debugging-port and a non-default --user-data-dir. ${error.message.split("\n")[0]}`);
        });
        const context = browser.contexts()[0] ?? (await browser.newContext());
        return { browser, context };
      }
      if (!executablePath) throw new Error("Set browser.providers.chromium.cdpUrl or executablePath to a Chromium-based browser such as Helium or Vivaldi.");
      const browser = await chromium.launch({ executablePath, headless });
      return { browser, context: await browser.newContext() };
    },
  });
}

export function createPlaywrightBrowserProvider(engine: PlaywrightEngine): BrowserProvider & { dispose(): Promise<void> } {
  const tabs = new Map<string, Page>();
  const states = new WeakMap<Page, PageState>();
  function track(p: Page) {
    const st: PageState = { logs: { console: [], network: [], dialogs: [] }, unseen: [] };
    states.set(p, st);
    p.on("console", m => { if (m.type() === "error" || m.type() === "warning") keep(st.logs.console, { type: m.type(), text: m.text().slice(0, 2000) }); });
    p.on("pageerror", e => keep(st.logs.console, { type: "pageerror", text: String(e.message).slice(0, 2000) }));
    p.on("requestfailed", r => keep(st.logs.network, { method: r.method(), url: r.url(), failure: r.failure()?.errorText ?? "failed" }));
    p.on("response", r => { if (r.status() >= 400) keep(st.logs.network, { method: r.request().method(), url: r.url(), status: r.status() }); });
    // A listener means Playwright no longer answers dialogs itself, so every path must answer.
    p.on("dialog", (d: Dialog) => {
      const arm = st.arm; st.arm = undefined;
      const accept = arm ? arm.accept : d.type() === "beforeunload";
      const record: BrowserDialog = { type: d.type(), message: d.message().slice(0, 2000), answer: accept ? "accepted" : "dismissed" };
      keep(st.logs.dialogs, record); keep(st.unseen, record);
      void (accept ? d.accept(arm?.promptText) : d.dismiss()).catch(() => {});
    });
    return st;
  }
  const state = (p: Page) => states.get(p) ?? track(p);
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
      const tabId = `tab_${Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex")}`;
      tabs.set(tabId, p); track(p);
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
  Object.assign(provider, {
    async history({ tabId, action }, signal) {
      signal.throwIfAborted();
      const p = page(tabId);
      if (action === "reload") await p.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      else if (!(await (action === "back" ? p.goBack({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS }) : p.goForward({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS })))
        && p.url() === "about:blank") throw new Error(`No ${action === "back" ? "earlier" : "later"} page in this tab.`);
      return tab(tabId, p);
    },
    async press({ tabId, keys, ref, selector }, signal) {
      signal.throwIfAborted();
      const p = page(tabId); await engine.prepare?.(p);
      if (ref !== undefined || selector !== undefined) await locator(p, { tabId, ref, selector }).press(keys, { timeout: ACTION_MS });
      else await p.keyboard.press(keys);
    },
    async pointer({ tabId, action, points, button, clickCount }, signal) {
      signal.throwIfAborted();
      const p = page(tabId); await engine.prepare?.(p);
      const [first, ...rest] = points;
      if (!first) throw new Error("No points.");
      if (action === "click") { await p.mouse.click(first.x, first.y, { button: button ?? "left", clickCount: clickCount ?? 1 }); return; }
      await p.mouse.move(first.x, first.y);
      if (action === "hover") return;
      await p.mouse.down({ button: button ?? "left" });
      try { for (const pt of rest) { signal.throwIfAborted(); await p.mouse.move(pt.x, pt.y, { steps: 4 }); } }
      finally { await p.mouse.up({ button: button ?? "left" }); }
    },
    async hover(request, signal) { signal.throwIfAborted(); const p = page(request.tabId); await engine.prepare?.(p); await locator(p, request).hover({ timeout: ACTION_MS }); },
    async select(request, signal) {
      signal.throwIfAborted();
      const p = page(request.tabId), target = locator(p, request);
      // Accept a value or a visible label for each option.
      const options = await target.evaluate((el, wanted) => {
        const list = Array.from((el as unknown as { options?: ArrayLike<{ value: string; label: string }> }).options ?? []);
        return wanted.map(w => list.find(o => o.value === w)?.value ?? list.find(o => o.label.trim() === w.trim())?.value ?? w);
      }, request.values, { timeout: ACTION_MS });
      return target.selectOption(options, { timeout: ACTION_MS });
    },
    async check(request, signal) { signal.throwIfAborted(); const p = page(request.tabId); await engine.prepare?.(p); await locator(p, request).setChecked(request.checked, { timeout: ACTION_MS }); },
    async upload(request, signal) {
      signal.throwIfAborted();
      for (const f of request.files) if (!(await stat(f).catch(() => undefined))?.isFile()) throw new Error(`No file at ${f}. Nothing was uploaded.`);
      await locator(page(request.tabId), request).setInputFiles(request.files, { timeout: ACTION_MS });
    },
    async dialog({ tabId, accept, promptText }, signal) { signal.throwIfAborted(); state(page(tabId)).arm = { accept, ...(promptText !== undefined ? { promptText } : {}) }; },
    async wait({ tabId, text, selector, state: load, timeoutMs }, signal) {
      signal.throwIfAborted();
      const p = page(tabId), s = timeoutMs / 1000;
      try {
        if (text) await p.getByText(text).first().waitFor({ state: "visible", timeout: timeoutMs });
        if (selector) await p.locator(selector).first().waitFor({ state: "visible", timeout: timeoutMs });
        if (load) await p.waitForLoadState(load, { timeout: timeoutMs });
      } catch (error) {
        if ((error as Error).name !== "TimeoutError") throw error;
        throw new Error(`Waited ${s}s: ${text ? `text "${text}"` : selector ? `selector ${selector}` : `load state ${load}`} did not show. The page is at ${p.url()}.`);
      }
      return tab(tabId, p);
    },
    async logs({ tabId, clear }, signal) {
      signal.throwIfAborted();
      const st = state(page(tabId)), out = structuredClone(st.logs);
      if (clear) st.logs = { console: [], network: [], dialogs: [] };
      return out;
    },
    async dialogs({ tabId }) { const st = state(page(tabId)), out = st.unseen; st.unseen = []; return out; },
    async evaluate({ tabId, script }, signal) {
      signal.throwIfAborted();
      return page(tabId).evaluate(script);
    },
  } satisfies Partial<BrowserProvider>);
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
    const b = browser, pages = [...tabs.values()]; browser = undefined; context = undefined; tabs.clear();
    // An attached browser outlives Luna: close only the tabs she opened, then disconnect.
    await Promise.all(pages.map(p => p.close().catch(() => {})));
    await b?.close().catch(() => {}); await engine.stop?.();
  } });
}
