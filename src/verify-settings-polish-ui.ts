// Compact settings contract: real API, isolated configuration, no external model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
import { parseConfig } from './config.js';
import { startRuntime } from './runtime.js';
import { createApp } from './server.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUNA_PLAYWRIGHT_PATH || 'playwright');
const dir = mkdtempSync(join(tmpdir(), 'luna-settings-polish-'));
const path = join(dir, 'config.json');
const raw = { dataDir: join(dir, 'data'), provider: 'faux', model: 'main', providers: [], extensions: ['memory', 'skills'],
  auxiliary: { side_question: { provider: 'faux', model: 'child' } },
  mcpServers: [{ name: 'secure', transport: 'http', url: 'http://localhost/mcp', enabled: false, headers: { Authorization: 'preserve-this-secret' } }] };
writeFileSync(path, JSON.stringify(raw));
mkdirSync(join(dir, 'data/skills/sample'), { recursive: true });
writeFileSync(join(dir, 'data/skills/sample/SKILL.md'), '---\nname: sample\ndescription: Use for UI testing.\n---\nRead these sample instructions.\n');
const faux = fauxProvider({ models: [{ id: 'main' }, { id: 'child' }] });
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: 'faux', modelId: 'main' };
const rt = await startRuntime({ ...parseConfig(raw, dir, {}), configPath: path }, { models, model });
const app = createApp({ harness: rt.harness, settings: rt.settings, models: rt.models, providers: rt.providers, mcp: rt.mcp, memory: rt.memory, skillDirs: rt.skillDirs, agent: { model }, token: 'test' });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } }); page.setDefaultTimeout(10000);
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('dialog', (d: any) => d.accept());
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('#token').fill('test'); await page.locator('#loginForm button').click(); await page.locator('#login').waitFor({ state: 'hidden' });
  await page.locator('[data-panel="settings"]').click();
  const screen = page.locator('#settings-screen');
  await screen.locator('[data-setting="busyInput.mode"]').waitFor({ state: 'attached' });
  const tab = async (id: string) => { await page.locator(`[data-settings-tab="${id}"]`).click(); };
  const group = async (id: string) => {
    const node = screen.locator(`.settings-body [data-section="${id}"]`).first();
    if (!await node.evaluate((el: any) => el.open)) await node.locator(':scope > summary').click();
  };
  const expand = async () => { await screen.locator('.settings-body details').evaluateAll((els: any[]) => els.forEach(el => { el.open = true; })); };
  const field = (key: string) => screen.locator(`[data-setting="${key}"]`);
  const snapshot = readFileSync(path, 'utf8');
  for (const id of ['general', 'models', 'context', 'images', 'tools', 'automation', 'system']) {
    await tab(id);
    assert.equal(await screen.locator('.settings-card').evaluateAll((els: any[]) => els.length > 0 && els.every(el => el.tagName === 'DETAILS' && !el.open)), true, id + ' groups start collapsed');
    assert.equal(await screen.locator('.settings-body details[open]').count(), 0, id + ' nested groups start collapsed');
  }
  assert.equal(readFileSync(path, 'utf8'), snapshot, 'Browsing/collapse does not write config');
  assert.equal(await screen.getByText('Unsaved changes', { exact: true }).count(), 0, 'Disclosure changes do not change the draft');
  await tab('general'); await group('busyInput');
  assert.equal(await field('busyInput.mode').evaluate((el: any) => el.tagName), 'SELECT');
  await field('busyInput.mode').selectOption('queue');
  await screen.locator('[data-section="busyInput"] > summary').click();
  assert.match(await screen.locator('[data-section="busyInput"] > summary').textContent(), /queue/i);
  await tab('models'); await group('auxiliary'); await group('auxiliary.side_question');
  await field('auxiliary.side_question').selectOption('faux/main');
  await tab('images'); await group('image_gen');
  assert.equal(await field('image_gen.provider').evaluate((el: any) => el.tagName), 'SELECT');
  await field('image_gen.provider').selectOption('openai-codex');
  await expand(); await field('image_gen.openai-codex.quality').selectOption('high');
  await group('vision'); await expand();
  await screen.getByRole('button', { name: 'Add vision profile', exact: true }).click(); await expand();
  const profileKey = screen.getByRole('textbox', { name: 'Vision profiles key', exact: true }).last();
  for (const reserved of ['__proto__', 'constructor', 'prototype', '   ']) {
    await profileKey.fill(reserved); await profileKey.press('Tab');
    assert.equal(await profileKey.inputValue(), 'profile_1', 'Unsafe profile names are rejected');
  }
  await profileKey.fill('faux/main'); await profileKey.press('Tab'); await expand();
  await field('vision.profiles.faux/main.tool_result_images').check();
  await tab('system'); await group('server');
  await field('server.host').selectOption('__custom__');
  await screen.locator('[data-custom-setting="server.host"]').fill('::1');
  await tab('tools'); await group('extensions');
  const menuButton = screen.getByRole('button', { name: 'Choose built-in tools', exact: true });
  await menuButton.click();
  await page.getByRole('menuitemcheckbox', { name: 'Coding', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'hidden' });
  assert.equal(await menuButton.evaluate((el: any) => el === (globalThis as any).document.activeElement), true, 'Menu restores focus');
  await group('mcpServers');
  assert.equal(await screen.locator('[data-section="mcpServers.0"]').evaluate((el: any) => el.open), false, 'MCP entry starts closed');
  await expand(); assert.equal(await field('mcpServers.0.headers.Authorization').inputValue(), '<secret: unchanged>');
  await page.locator('[data-settings-save]').click();
  await screen.getByText('Saved. Restart Luna to apply runtime changes.', { exact: true }).waitFor();
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.busyInput.mode, 'queue'); assert.equal(saved.auxiliary.side_question.model, 'main');
  assert.equal(saved.image_gen.provider, 'openai-codex'); assert.equal(saved.image_gen['openai-codex'].quality, 'high');
  assert.equal(saved.server.host, '::1'); assert.equal(saved.vision.profiles['faux/main'].tool_result_images, true);
  assert.ok(saved.extensions.includes('coding')); assert.equal(saved.mcpServers[0].headers.Authorization, 'preserve-this-secret');
  await page.reload(); await field('web.searchProvider').waitFor({ state: 'attached' });
  assert.equal(await screen.locator('.settings-body details[open]').count(), 0, 'Reload restores closed defaults');
  await tab('system'); await group('server');
  assert.equal(await screen.locator('[data-custom-setting="server.host"]').inputValue(), '::1', 'Custom choices survive reload');
  await tab('models'); await page.locator('[data-settings-view="providers"]').click();
  await screen.locator('[data-provider="anthropic"]').waitFor();
  assert.equal(await screen.locator('[data-provider="anthropic"]').evaluate((el: any) => el.tagName === 'DETAILS' && !el.open), true, 'Account options start collapsed');
  await tab('tools'); await page.locator('[data-settings-view="mcp"]').click();
  assert.equal(await screen.locator('[data-manager-form="mcp-add"]').evaluate((el: any) => el.tagName === 'DETAILS' && !el.open), true, 'Connection form starts collapsed');
  await tab('context'); await page.locator('[data-settings-view="memory"]').click();
  assert.equal(await screen.locator('[data-manager-form="memory-add"]').evaluate((el: any) => el.tagName === 'DETAILS' && !el.open), true);
  await page.locator('[data-settings-view="skills"]').click();
  const skill = screen.locator('[data-skill="sample"]'); await skill.waitFor();
  assert.equal(await skill.evaluate((el: any) => el.open), false);
  await skill.locator('summary').click(); await skill.getByText(/Read these sample instructions/).waitFor();
  await skill.locator('summary').click(); assert.equal(await skill.locator('pre').isVisible(), false);
  await page.setViewportSize({ width: 375, height: 900 });
  await tab('tools'); await group('extensions'); await menuButton.click();
  await page.getByRole('menu').waitFor();
  await page.getByRole('menu').evaluate((el: any) => Promise.all(el.getAnimations().map((animation: any) => animation.finished)));
  await page.screenshot({ path: '/tmp/luna-settings-polish-menu-mobile.png' });
  assert.equal(await page.getByRole('menu').evaluate((el: any) => { const box = el.getBoundingClientRect(); return box.left >= 0 && box.right <= (globalThis as any).innerWidth && box.bottom <= (globalThis as any).innerHeight; }), true, 'Options menu fits the phone viewport');
  await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
  for (const width of [1920, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const id of ['general', 'models', 'context', 'images', 'tools', 'automation', 'system']) {
      await tab(id); await expand();
      assert.equal(await screen.evaluate((el: any) => el.scrollWidth <= el.clientWidth + 1), true, id + ' expanded overflow ' + width);
      assert.equal(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
    }
    await tab('tools'); await page.screenshot({ path: `/tmp/luna-settings-polish-collapsed-${width}.png` });
    await group('web'); await expand(); await page.screenshot({ path: `/tmp/luna-settings-polish-expanded-${width}.png` });
  }
  assert.deepEqual(errors, []);
  console.log('SETTINGS_POLISH_UI_OK: collapsed defaults, choice menus, drafts, persistence, secret preservation, inline managers, keyboard, desktop/mobile');
} finally {
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); rmSync(dir, { recursive: true, force: true });
}
