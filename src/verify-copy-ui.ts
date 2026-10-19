// Real browser clipboard checks against the production markdown renderer and message footer.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');
const code = '  const greeting = "مرحبا <tag> & café";\n\n\tconsole.log(greeting);  ';
const text = `Example\n\n\`\`\`ts\n${code}\n\`\`\``;
const server = await createServer({
  configFile: new URL('../web/vite.config.ts', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'copy-test-page', configureServer(vite) {
    vite.middlewares.use('/copy-test.html', async (_req, res) => {
  const html = `<div id="markdown"></div><div id="footer"></div><textarea id="composer">draft</textarea><script type="module">
    import { markdown } from '/src/lib/markdown.ts';
    import { createApp, h } from 'vue';
    import MessageFooter from '/src/components/chat/MessageFooter.vue';
    document.querySelector('#markdown').append(markdown(${JSON.stringify(text)}));
    createApp({ render: () => h(MessageFooter, { text: ${JSON.stringify(text)} }) }).mount('#footer');
  </script>`;
  res.setHeader('Content-Type', 'text/html');
  res.end(await vite.transformIndexHtml('/copy-test.html', html));
    });
  } }],
});
await server.listen();
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}copy-test.html`);
  const codeButton = page.locator('.codewrap button');
  const messageButton = page.getByRole('button', { name: 'Copy message', exact: true });
  await codeButton.waitFor();
  await messageButton.waitFor();
  await page.evaluate(`window.originalClipboard = navigator.clipboard; window.originalExecCommand = document.execCommand.bind(document)`);
  const clipboard = () => page.evaluate('window.originalClipboard.readText()');
  // Native API success: copy the code only, with indentation and Unicode unchanged.
  await codeButton.click();
  assert.equal(await clipboard(), code);
  assert.equal(await codeButton.textContent(), 'copied');
  await messageButton.click();
  assert.equal(await clipboard(), text);
  assert.equal(await page.locator('#footer [aria-live]').textContent().then((s: string) => s.trim()), 'Copied to clipboard');
  // Plain HTTP: no Clipboard API, but a real browser copy command still works.
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })`);
  await codeButton.click();
  assert.equal(await clipboard(), code, 'Code copy must use the fallback when the API is absent');
  assert.equal(await codeButton.textContent(), 'copied');
  await messageButton.click();
  assert.equal(await clipboard(), text, 'Message copy must use the same fallback');
  // A denied API must also fall back, rather than claim success or reject unhandled.
  await page.evaluate(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Permission denied'); } } })`);
  await codeButton.click();
  assert.equal(await clipboard(), code);
  // Failed fallback: report failure and keep the previous clipboard contents.
  await page.evaluate(`document.execCommand = () => false`);
  await codeButton.click();
  assert.equal(await codeButton.textContent(), 'copy failed');
  assert.equal(await clipboard(), code);
  await messageButton.click();
  assert.equal(await page.locator('#footer [aria-live]').textContent().then((s: string) => s.trim()), 'Failed to copy');
  await page.waitForFunction(`document.querySelector('.codewrap button').textContent === 'copy'`);
  // Recovery and focus restoration after fallback.
  await page.evaluate(`document.execCommand = window.originalExecCommand; document.querySelector('#composer').focus(); document.querySelector('.codewrap button').click()`);
  await page.waitForFunction(`document.querySelector('.codewrap button').textContent === 'copied'`);
  assert.equal(await clipboard(), code);
  assert.equal(await page.evaluate('document.activeElement.id'), 'composer');
  assert.equal(await page.locator('textarea[aria-hidden]').count(), 0);
  assert.deepEqual(errors, []);
  console.log('COPY_UI_OK: native clipboard, absent API, rejected API, failure feedback, recovery, exact code and message contents');
} finally {
  await browser?.close();
  await server.close();
}
