// Real app layout with a simulated visual viewport. Headless Chromium has no software keyboard.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
// These names are evaluated only inside Playwright's browser callbacks.
declare const window: any;
declare const document: any;
declare const innerWidth: number;
const { chromium } = createRequire(import.meta.url)('playwright');
const server = await createServer({
  configFile: new URL('../web/vite.config.ts', import.meta.url).pathname,
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 393, height: 800 }, isMobile: true, hasTouch: true });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await page.route('**/health', (route: any) => route.fulfill({ json: { auth: false } }));
  await page.route('**/v1/**', (route: any) => route.fulfill({ json: { models: [], default: null, projects: [], sessions: [], jobs: [] } }));
  await page.goto(server.resolvedUrls!.local[0]);
  await page.locator('#input').waitFor();
  await page.locator('#input').fill('Keep this draft');
  const check = async (height: number, top = 0) => {
    await page.waitForFunction(({ height, top }: { height: number; top: number }) => {
      const app = document.querySelector('#app')!.getBoundingClientRect();
      const compose = document.querySelector('#compose')!.getBoundingClientRect();
      return Math.abs(app.height - height) < 1 && Math.abs(app.top - top) < 1 && Math.abs(compose.bottom - (height + top)) < 1;
    }, { height, top }, { timeout: 4000 });
    assert.equal(await page.locator('#input').inputValue(), 'Keep this draft');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  };
  const viewport = (height: number, offsetTop = 0, event = 'resize', scale = 1) => page.evaluate(
    ({ height, offsetTop, event, scale }: any) => {
      Object.assign(window.visualViewport!, { height, offsetTop, scale });
      window.visualViewport!.dispatchEvent(new Event(event));
    }, { height, offsetTop, event, scale });
  await check(800);
  // Android's keyboard shrinks only the visual viewport, not CSS vh/dvh.
  await viewport(380);
  await check(380);
  await page.locator('#more').click();
  const dialog = await page.locator('#panel [role="dialog"]').boundingBox();
  assert.ok(dialog && dialog.y >= 0 && dialog.y + dialog.height <= 381, 'Dialogs must fit above the keyboard');
  await page.locator('#pclose').click();
  await page.locator('#menu').click();
  const drawer = await page.locator('#side').boundingBox();
  assert.ok(drawer && drawer.y >= 0 && drawer.y + drawer.height <= 381, 'Navigation must fit above the keyboard');
  await page.locator('#side-close').click();
  // Browser focus panning must not hide the header or move the composer below the keyboard.
  await viewport(380, 48, 'scroll');
  await check(380, 48);
  await viewport(800);
  await check(800);
  // Pinch zoom must not reflow the app into the magnified viewport.
  await viewport(400, 0, 'resize', 2);
  await check(800);
  await viewport(800);
  await page.setViewportSize({ width: 800, height: 393 });
  await viewport(393);
  await check(393);
  // Browsers without VisualViewport use the CSS dynamic viewport fallback.
  await page.addInitScript(() => Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined }));
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.reload();
  await page.locator('#input').fill('Keep this draft');
  await check(800);
  await page.setViewportSize({ width: 1200, height: 600 });
  await check(600);
  console.log('MOBILE_VIEWPORT_UI_OK: keyboard open/close, focus pan, draft retention, zoom, rotation, desktop and no-API fallback');
} finally {
  await browser?.close();
  await server.close();
}
