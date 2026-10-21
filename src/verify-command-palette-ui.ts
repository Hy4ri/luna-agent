// Command palette contract: real built UI, real settings API, isolated configuration, no model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { parseConfig } from './config.js';
import { startRuntime } from './runtime.js';
import { createApp } from './server.js';

const { chromium } = createRequire(import.meta.url)(process.env.LUNA_PLAYWRIGHT_PATH || 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'luna-palette-ui-'));
const path = join(dir, 'config.json');
const raw = { dataDir: join(dir, 'data'), provider: 'faux', model: 'main', providers: [], extensions: ['memory', 'skills'] };
writeFileSync(path, JSON.stringify(raw));
const faux = fauxProvider({ models: [{ id: 'main' }, { id: 'other' }] });
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: 'faux', modelId: 'main' };
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: path }, { models, model });
const app = createApp({ harness: rt.harness, settings: rt.settings, models: rt.models, providers: rt.providers, conversations: rt.conversations, memory: rt.memory, skillDirs: rt.skillDirs, agent: { model }, token: 'test' });
const headers = { authorization: 'Bearer test', 'content-type': 'application/json' };
const request = async (route: string, method = 'GET', body?: unknown) => {
  const response = await app.request(route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.ok(response.ok, `${method} ${route}: ${response.status}`);
  return response.json() as Promise<any>;
};
const disk = () => JSON.parse(readFileSync(path, 'utf8'));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
let browser: any;
try {
  const first = String((await request('/v1/sessions', 'POST', {})).id);
  const second = String((await request('/v1/sessions', 'POST', {})).id);
  await request(`/v1/sessions/${first}/metadata`, 'PATCH', { title: 'Alpha notes' });
  await request(`/v1/sessions/${second}/metadata`, 'PATCH', { title: 'Beta plans' });

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('dialog', (d: any) => d.accept());
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('#token').fill('test'); await page.locator('#loginForm button').click(); await page.locator('#login').waitFor({ state: 'hidden' });
  await page.locator('#input').waitFor();

  const palette = page.locator('#command-palette');
  const input = page.locator('#palette-input');
  const option = (id: string) => palette.locator(`[data-command="${id}"]`);
  const openPalette = async () => { await page.keyboard.press('Control+k'); await palette.waitFor(); };
  const run = async (text: string, id: string) => {
    await input.fill(text);
    await option(id).waitFor();
    assert.equal(await palette.locator('[aria-selected="true"]').getAttribute('data-command'), id, `"${text}" selects ${id} first`);
    await input.press('Enter');
  };

  // Shortcut opens with focus in the filter; Ctrl+K again closes.
  await openPalette();
  if (process.env.PALETTE_SHOT) await page.screenshot({ path: '/tmp/luna-command-palette-desktop.png' });
  assert.equal(await page.evaluate(() => (globalThis as any).document.activeElement?.id), 'palette-input', 'Filter input takes focus');
  await page.keyboard.press('Control+k'); await palette.waitFor({ state: 'hidden' });

  // Arrow keys move the active option; the filter reports no matches honestly.
  await openPalette();
  const firstId = await palette.locator('[aria-selected="true"]').getAttribute('data-command');
  await input.press('ArrowDown');
  assert.notEqual(await palette.locator('[aria-selected="true"]').getAttribute('data-command'), firstId, 'ArrowDown moves the selection');
  await input.fill('zzz-no-such-command');
  await palette.locator('.palette-empty').waitFor();

  // Switch screens.
  await run('analytics', 'view:analytics');
  await palette.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => (globalThis as any).location.hash === '#analytics');
  await openPalette(); await run('settings automation', 'settings:automation');
  await page.locator('[data-settings-tab="automation"][aria-selected="true"]').waitFor();
  await openPalette(); await run('go to chat', 'view:chat');
  await page.locator('#chat-workspace').waitFor({ state: 'visible' });

  // Open a panel; Escape closes only the palette that sits above it.
  await openPalette(); await run('project board', 'panel:board');
  await page.locator('#ptitle', { hasText: 'Project board' }).waitFor();
  await openPalette(); await page.keyboard.press('Escape'); await palette.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#panel').isVisible(), true, 'Escape in the palette keeps the panel open');
  await page.keyboard.press('Escape'); await page.locator('#panel').waitFor({ state: 'hidden' });

  // Switch conversations; the current one is marked.
  await openPalette(); await run('beta', 'session:' + second);
  await page.locator('#title', { hasText: 'Beta plans' }).waitFor();
  assert.equal(await page.evaluate(() => (globalThis as any).sessionStorage.getItem('luna.session')), second);
  await openPalette(); await input.fill('beta');
  assert.equal(await option('session:' + second).getAttribute('aria-current'), 'true', 'Open conversation is marked current');
  await page.keyboard.press('Escape');

  // Toggle a boolean setting: the palette stays open, shows the saved state, and the file changes.
  assert.equal(disk().compaction?.enabled ?? true, true);
  await openPalette(); await run('automatic compaction', 'setting:compaction.enabled');
  await palette.locator('#palette-status', { hasText: 'Saved' }).waitFor();
  assert.equal(await option('setting:compaction.enabled').locator('.palette-state').textContent(), 'Off');
  assert.equal(disk().compaction.enabled, false, 'Boolean toggle is written to the config file');
  await page.keyboard.press('Escape');
  // Every open refreshes from the server, so an external change appears.
  await request('/v1/settings', 'PUT', { config: { ...disk(), compaction: { ...disk().compaction, enabled: true } }, revision: (await request('/v1/settings')).revision });
  await openPalette(); await input.fill('automatic compaction');
  await option('setting:compaction.enabled').locator('.palette-state', { hasText: 'On' }).waitFor();

  // Choose an enum value.
  await run('messages during queue', 'setting:busyInput.mode=queue');
  await option('setting:busyInput.mode=queue').and(palette.locator('[aria-current="true"]')).waitFor();
  assert.equal(disk().busyInput.mode, 'queue', 'Enum choice is written to the config file');
  await page.keyboard.press('Escape');

  // Unsaved Settings edits block palette writes instead of being overwritten.
  await openPalette(); await run('settings chat', 'settings:general');
  const mode = page.locator('#settings-screen [data-setting="busyInput.mode"]');
  await mode.waitFor({ state: 'attached' });
  await page.locator('#settings-screen .settings-body details').evaluateAll((els: any[]) => els.forEach(el => { el.open = true; }));
  await mode.selectOption('steer');
  await openPalette(); await run('automatic compaction', 'setting:compaction.enabled');
  await palette.locator('#palette-status', { hasText: 'Save or discard' }).waitFor();
  assert.equal(disk().compaction.enabled, true, 'Blocked write leaves the file unchanged');
  await page.keyboard.press('Escape');
  await page.locator('[data-settings-save]').click();
  for (let i = 0; i < 50 && disk().busyInput.mode !== 'steer'; i++) await page.waitForTimeout(100);
  assert.equal(disk().busyInput.mode, 'steer');
  // A clean Settings page reloads after a palette write, so its next Save cannot hit a stale revision.
  await openPalette(); await run('automatic compaction', 'setting:compaction.enabled');
  await palette.locator('#palette-status', { hasText: 'Saved' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(disk().compaction.enabled, false);
  await page.locator('#settings-screen .settings-loading').waitFor({ state: 'detached' });
  await page.locator('#settings-configuration').waitFor();
  await page.locator('#settings-screen .settings-body details').evaluateAll((els: any[]) => els.forEach(el => { el.open = true; }));
  await mode.selectOption('interrupt');
  await page.locator('[data-settings-save]').click();
  for (let i = 0; i < 50 && disk().busyInput.mode !== 'interrupt'; i++) await page.waitForTimeout(100);
  assert.equal(disk().busyInput.mode, 'interrupt', 'Settings page saves after a palette write');
  assert.equal(disk().compaction.enabled, false, 'Settings page save keeps the palette write');

  // Layout toggles.
  await openPalette(); await run('go to chat', 'view:chat');
  await openPalette(); await run('split view', 'layout:split');
  await page.locator('#secondary-pane').waitFor({ state: 'visible' });
  assert.equal(await option('layout:split').locator('.palette-state').textContent(), 'On');
  await input.press('Enter'); await page.locator('#secondary-pane').waitFor({ state: 'hidden' });
  await run('collapse sidebar', 'layout:sidebar');
  await page.locator('aside#side.collapsed').waitFor();
  await page.keyboard.press('Escape');

  // The sidebar entry opens it without a keyboard.
  await page.locator('#open-palette').click(); await palette.waitFor();
  await page.keyboard.press('Escape');

  // Phone viewport: the drawer closes and the palette fits.
  await page.setViewportSize({ width: 375, height: 760 });
  await page.locator('#menu').click(); await page.locator('#open-palette').click(); await palette.waitFor();
  assert.equal(await palette.evaluate((el: any) => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= (globalThis as any).innerWidth && box.bottom <= (globalThis as any).innerHeight; }), true, 'Palette fits the phone viewport');
  await page.screenshot({ path: '/tmp/luna-command-palette-mobile.png' });

  assert.deepEqual(errors, []);
  console.log('COMMAND_PALETTE_UI_OK: shortcut, filter, screens, panels, conversations, boolean and enum settings, dirty guard, layout toggles, mobile');
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
