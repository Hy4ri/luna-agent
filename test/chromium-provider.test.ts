// The Playwright provider against a real Chromium: richer actions do what they say. Skips without a browser.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "bun:test";
import { createChromiumBrowserProvider } from "../src/chromium-browser-provider.js";

const executablePath = process.env.LUNA_TEST_CHROMIUM ?? "/usr/bin/chromium";
const it = existsSync(executablePath) ? test : test.skip;
const PAGE = `<!doctype html><title>t</title>
<input id="q"><select id="s"><option value="a">Apple</option><option value="b">Banana</option></select>
<input id="c" type="checkbox"><input id="f" type="file">
<button id="ask" onclick="document.body.dataset.answer = String(confirm('Sure?'))">ask</button>
<canvas id="pad" width="200" height="100" style="position:absolute;left:0;top:200px"></canvas>
<a id="next" href="/two">next</a>
<script>
  window.keys = []; document.addEventListener("keydown", e => keys.push(e.key));
  window.moves = 0; document.addEventListener("mousemove", () => moves++);
  window.strokes = 0; const pad = document.getElementById("pad");
  pad.addEventListener("pointermove", e => { if (e.buttons & 1) strokes++; });
  setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>Ready now</p>"), 300);
  console.error("boom"); fetch("/missing");
</script>`;

it("chromium provider: keys, points, drag, forms, dialogs, wait, logs, history, evaluate", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/") return new Response(PAGE, { headers: { "content-type": "text/html" } });
      if (path === "/two") return new Response("<title>two</title>two", { headers: { "content-type": "text/html" } });
      return new Response(null, { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const p = createChromiumBrowserProvider(() => ({ executablePath, headless: true }));
  const s = new AbortController().signal;
  const ev = (script: string) => p.evaluate!({ tabId, script }, s);
  const { tabId } = await p.open({ url: `${base}/` }, s);
  try {
    await p.wait!({ tabId, text: "Ready now", timeoutMs: 5000 }, s);
    await expect(p.wait!({ tabId, text: "Never", timeoutMs: 300 }, s)).rejects.toThrow(/Waited 0.3s: text "Never" did not show/);

    await p.press!({ tabId, keys: "Escape" }, s);
    await p.type({ tabId, selector: "#q", text: "hello" }, s);
    await p.press!({ tabId, selector: "#q", keys: "Control+A" }, s);
    await p.press!({ tabId, keys: "Backspace" }, s);
    expect(await ev("[keys[0], document.getElementById('q').value]")).toEqual(["Escape", ""]);

    await p.pointer!({ tabId, action: "drag", points: [{ x: 20, y: 220 }, { x: 100, y: 250 }, { x: 180, y: 280 }] }, s);
    expect((await ev("strokes")) as number >= 4).toBeTruthy() /* "drag moves with the button held" */;
    await p.pointer!({ tabId, action: "click", points: [{ x: 5, y: 5 }] }, s);

    expect(await p.select!({ tabId, selector: "#s", values: ["Banana"] }, s)).toEqual(["b"]);
    await p.check!({ tabId, selector: "#c", checked: true }, s);
    const dir = mkdtempSync(join(tmpdir(), "luna-upload-")), file = join(dir, "a.txt");
    writeFileSync(file, "x");
    await p.upload!({ tabId, selector: "#f", files: [file] }, s);
    await expect(p.upload!({ tabId, selector: "#f", files: [join(dir, "none")] }, s)).rejects.toThrow(/No file at/);
    expect(await ev("[document.getElementById('c').checked, document.getElementById('f').files[0].name]")).toEqual([true, "a.txt"]);

    await ev("moves = 0");
    await p.click({ tabId, selector: "#ask" }, s);
    expect(await ev("document.body.dataset.answer")).toBe("false") /* "an unarmed confirm is dismissed" */;
    expect((await ev("moves")) as number >= 8).toBeTruthy() /* "an element click glides the mouse there" */;
    expect(await p.dialogs!({ tabId }, s)).toEqual([{ type: "confirm", message: "Sure?", answer: "dismissed" }]);
    await p.dialog!({ tabId, accept: true }, s);
    await p.click({ tabId, selector: "#ask" }, s);
    expect(await ev("document.body.dataset.answer")).toBe("true");

    const logs = await p.logs!({ tabId, clear: true }, s);
    expect(logs.console.some(l => l.text === "boom")).toBeTruthy();
    expect(logs.network.some(n => n.status === 404 && n.url.endsWith("/missing"))).toBeTruthy();
    expect(logs.dialogs.length).toBe(2);
    expect((await p.logs!({ tabId }, s)).dialogs.length).toBe(0);

    await p.click({ tabId, selector: "#next" }, s);
    await p.wait!({ tabId, text: "two", timeoutMs: 5000 }, s);
    expect((await p.history!({ tabId, action: "back" }, s)).url).toBe(`${base}/`);
    expect((await p.history!({ tabId, action: "forward" }, s)).url).toBe(`${base}/two`);
    expect((await p.history!({ tabId, action: "reload" }, s)).url).toBe(`${base}/two`);
    expect(p.has!(tabId)).toBe(true);
    await p.close({ tabId }, s);
    expect(p.has!(tabId)).toBe(false);
  } finally {
    await p.dispose();
    server.stop(true);
  }
}, 60_000);

it("chromium provider attached by cdpUrl: shares the browser's logins, closes only its own tabs, leaves the browser running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-cdp-"));
  const proc = Bun.spawn([executablePath, "--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      if (new URL(req.url).pathname === "/") seen.push(req.headers.get("cookie") ?? "");
      return new Response("<title>in</title>signed in", { headers: { "content-type": "text/html" } });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const { chromium } = await import("playwright");
  let owner: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const ws = await new Promise<string>((resolve, reject) => {
      let err = "";
      void (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            err += decoder.decode(value, { stream: true });
            const m = /DevTools listening on (ws:\/\/\S+)/.exec(err);
            if (m) { resolve(m[1]!); return; }
          }
        } catch {
          // ignore
        } finally {
          reader.releaseLock();
        }
      })();
      void proc.exited.then(() => reject(new Error(`chromium exited: ${err.slice(-500)}`)));
    });
    const cdpUrl = `http://${new URL(ws).host}`;
    // The user's own session: a login cookie and a tab of theirs.
    owner = await chromium.connectOverCDP(cdpUrl);
    const ctx = owner.contexts()[0]!;
    await ctx.addCookies([{ name: "session", value: "alex", url: base }]);
    const his = ctx.pages()[0]!;

    const p = createChromiumBrowserProvider(() => ({ cdpUrl, headless: true }));
    const s = new AbortController().signal;
    const { tabId } = await p.open({ url: `${base}/` }, s);
    expect(seen).toEqual(["session=alex"]) /* "Luna's tab sends the user's login" */;
    expect(ctx.pages().length).toBe(2);

    await p.dispose();
    await new Promise(r => setTimeout(r, 300));
    expect(proc.exitCode).toBe(null) /* "the attached browser keeps running" */;
    expect(ctx.pages()).toEqual([his]) /* "only Luna's tab closed" */;
    await expect(p.snapshot({ tabId }, s)).rejects.toThrow(/No open tab/);
  } finally {
    await owner?.close().catch(() => {});
    server.stop(true);
    if (proc.exitCode === null) { proc.kill(); await proc.exited; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

it("chromium provider: an unreachable cdpUrl says how to start the browser", async () => {
  const p = createChromiumBrowserProvider(() => ({ cdpUrl: "http://127.0.0.1:1", headless: true }));
  await expect(p.open({ url: "https://example.test/" }, new AbortController().signal)).rejects.toThrow(/No browser answers at http:\/\/127\.0\.0\.1:1\. Start it with --remote-debugging-port/);
});
