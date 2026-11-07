// The Playwright provider against a real Chromium: richer actions do what they say. Skips without a browser.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChromiumBrowserProvider } from "../src/chromium-browser-provider.js";

const executablePath = process.env.LUNA_TEST_CHROMIUM ?? "/usr/bin/chromium";
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

test("chromium provider: keys, points, drag, forms, dialogs, wait, logs, history, evaluate", { skip: !existsSync(executablePath) && "no Chromium", timeout: 60_000 }, async () => {
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
});
