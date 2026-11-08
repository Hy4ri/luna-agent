// The Playwright provider against a real Chromium: richer actions do what they say. Skips without a browser.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
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
  window.strokes = 0; const pad = document.getElementById("pad");
  pad.addEventListener("pointermove", e => { if (e.buttons & 1) strokes++; });
  setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<p>Ready now</p>"), 300);
  console.error("boom"); fetch("/missing");
</script>`;

it("chromium provider: keys, points, drag, forms, dialogs, wait, logs, history, evaluate", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/") { res.setHeader("content-type", "text/html"); res.end(PAGE); }
    else if (req.url === "/two") { res.setHeader("content-type", "text/html"); res.end("<title>two</title>two"); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const p = createChromiumBrowserProvider(() => ({ executablePath, headless: true }));
  const s = new AbortController().signal;
  const ev = (script: string) => p.evaluate!({ tabId, script }, s);
  const { tabId } = await p.open({ url: `${base}/` }, s);
  try {
    await p.wait!({ tabId, text: "Ready now", timeoutMs: 5000 }, s);
    await assert.rejects(p.wait!({ tabId, text: "Never", timeoutMs: 300 }, s), /Waited 0.3s: text "Never" did not show/);

    await p.press!({ tabId, keys: "Escape" }, s);
    await p.type({ tabId, selector: "#q", text: "hello" }, s);
    await p.press!({ tabId, selector: "#q", keys: "Control+A" }, s);
    await p.press!({ tabId, keys: "Backspace" }, s);
    assert.deepEqual(await ev("[keys[0], document.getElementById('q').value]"), ["Escape", ""]);

    await p.pointer!({ tabId, action: "drag", points: [{ x: 20, y: 220 }, { x: 100, y: 250 }, { x: 180, y: 280 }] }, s);
    assert.ok((await ev("strokes")) as number >= 4, "drag moves with the button held");
    await p.pointer!({ tabId, action: "click", points: [{ x: 5, y: 5 }] }, s);

    assert.deepEqual(await p.select!({ tabId, selector: "#s", values: ["Banana"] }, s), ["b"]);
    await p.check!({ tabId, selector: "#c", checked: true }, s);
    const dir = mkdtempSync(join(tmpdir(), "luna-upload-")), file = join(dir, "a.txt");
    writeFileSync(file, "x");
    await p.upload!({ tabId, selector: "#f", files: [file] }, s);
    await assert.rejects(p.upload!({ tabId, selector: "#f", files: [join(dir, "none")] }, s), /No file at/);
    assert.deepEqual(await ev("[document.getElementById('c').checked, document.getElementById('f').files[0].name]"), [true, "a.txt"]);

    await p.click({ tabId, selector: "#ask" }, s);
    assert.equal(await ev("document.body.dataset.answer"), "false", "an unarmed confirm is dismissed");
    assert.deepEqual(await p.dialogs!({ tabId }, s), [{ type: "confirm", message: "Sure?", answer: "dismissed" }]);
    await p.dialog!({ tabId, accept: true }, s);
    await p.click({ tabId, selector: "#ask" }, s);
    assert.equal(await ev("document.body.dataset.answer"), "true");

    const logs = await p.logs!({ tabId, clear: true }, s);
    assert.ok(logs.console.some(l => l.text === "boom"));
    assert.ok(logs.network.some(n => n.status === 404 && n.url.endsWith("/missing")));
    assert.equal(logs.dialogs.length, 2);
    assert.equal((await p.logs!({ tabId }, s)).dialogs.length, 0);

    await p.click({ tabId, selector: "#next" }, s);
    await p.wait!({ tabId, text: "two", timeoutMs: 5000 }, s);
    assert.equal((await p.history!({ tabId, action: "back" }, s)).url, `${base}/`);
    assert.equal((await p.history!({ tabId, action: "forward" }, s)).url, `${base}/two`);
    assert.equal((await p.history!({ tabId, action: "reload" }, s)).url, `${base}/two`);
  } finally {
    await p.dispose();
    server.close();
  }
}, 60_000);

it("chromium provider attached by cdpUrl: shares the browser's logins, closes only its own tabs, leaves the browser running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "luna-cdp-"));
  const proc = spawn(executablePath, ["--headless=new", "--no-sandbox", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const seen: string[] = [];
  const server = createServer((req, res) => { if (req.url === "/") seen.push(req.headers.cookie ?? ""); res.setHeader("content-type", "text/html"); res.end("<title>in</title>signed in"); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import("playwright");
  let owner: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    const ws = await new Promise<string>((resolve, reject) => {
      let err = "";
      proc.stderr!.on("data", (d: Buffer) => { err += d; const m = /DevTools listening on (ws:\/\/\S+)/.exec(err); if (m) resolve(m[1]!); });
      proc.on("exit", () => reject(new Error(`chromium exited: ${err.slice(-500)}`)));
    });
    const cdpUrl = `http://${new URL(ws).host}`;
    // m57's own session: a login cookie and a tab of his.
    owner = await chromium.connectOverCDP(cdpUrl);
    const ctx = owner.contexts()[0]!;
    await ctx.addCookies([{ name: "session", value: "m57", url: base }]);
    const his = ctx.pages()[0]!;

    const p = createChromiumBrowserProvider(() => ({ cdpUrl, headless: true }));
    const s = new AbortController().signal;
    const { tabId } = await p.open({ url: `${base}/` }, s);
    assert.deepEqual(seen, ["session=m57"], "Luna's tab sends his login");
    assert.equal(ctx.pages().length, 2);

    await p.dispose();
    await new Promise(r => setTimeout(r, 300));
    assert.equal(proc.exitCode, null, "the attached browser keeps running");
    assert.deepEqual(ctx.pages(), [his], "only Luna's tab closed");
    await assert.rejects(p.snapshot({ tabId }, s), /No open tab/);
  } finally {
    await owner?.close().catch(() => {});
    server.close();
    if (proc.exitCode === null) { const gone = new Promise(r => proc.once("exit", r)); proc.kill(); await gone; }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}, 60_000);

it("chromium provider: an unreachable cdpUrl says how to start the browser", async () => {
  const p = createChromiumBrowserProvider(() => ({ cdpUrl: "http://127.0.0.1:1", headless: true }));
  await assert.rejects(p.open({ url: "https://example.test/" }, new AbortController().signal), /No browser answers at http:\/\/127\.0\.0\.1:1\. Start it with --remote-debugging-port/);
});
