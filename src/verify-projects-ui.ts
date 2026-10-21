// Real built UI + real HTTP project routes + temporary SQLite. No external model calls.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { startRuntime } from './runtime.js';
import { createApp } from './server.js';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';
const { chromium } = createRequire(import.meta.url)('playwright');
const dir = mkdtempSync(join(process.cwd(), '.projects-ui-'));
let rt: Awaited<ReturnType<typeof startRuntime>> | undefined, server: ReturnType<typeof serve> | undefined, browser: any;
try {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ dataDir: dir, provider: 'faux', model: 'main' }));
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  rt = await startRuntime(loadConfig(join(dir, 'config.json')), { models, model: { provider: m.provider, modelId: m.id } });
  for (const d of ['alpha', 'beta', 'gamma']) mkdirSync(join(dir, d));
  const alpha = rt.conversations.projects.create('Alpha', join(dir, 'alpha'));
  const beta = rt.conversations.projects.create('Beta', join(dir, 'beta'));
  const app = createApp({ harness: rt.harness, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations, projectExtensions: rt.projectExtensions, agent: { model: { provider: m.provider, modelId: m.id } } });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server!.listening ? r() : server!.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const seeded = await (await fetch(`${url}/v1/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: alpha.id }) })).json() as { id: number };
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu'] });

  // Desktop: centered floating window with list + detail.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(url);
  await page.locator('[data-panel="projects"]').click();
  const dialog = page.locator('#panel [role="dialog"]');
  await page.locator('.pw-item').first().waitFor();
  const rect = (await dialog.boundingBox())!;
  assert.ok(rect.width <= 900 && rect.width >= 800, `Projects window has a fixed width, got ${rect.width}`);
  assert.ok(Math.abs(rect.x + rect.width / 2 - 720) <= 2 && Math.abs(rect.y + rect.height / 2 - 500) <= 2, 'Projects window is centered, not a side drawer');
  console.log('PROJECTS_FLOATING_OK');

  assert.deepEqual(await page.locator('.pw-item-name').allTextContents(), ['General', 'Alpha', 'Beta']);
  assert.equal((await page.locator(`.pw-item[data-project="${alpha.id}"] .pw-count`).textContent())!.trim(), '1', 'Count reflects real conversations');
  assert.equal(await page.locator('.pw-main').isVisible(), true, 'Detail pane is visible on desktop');
  await page.locator(`.pw-item[data-project="${alpha.id}"]`).click();
  assert.equal(await page.locator('.pw-title').textContent(), 'Alpha');
  assert.equal(await page.locator('.pw-conv').count(), 1, 'Recent conversations list the project sessions');
  await page.getByLabel('Filter projects').fill('bet');
  assert.deepEqual(await page.locator('.pw-item-name').allTextContents(), ['Beta']);
  await page.getByLabel('Filter projects').fill('');
  console.log('PROJECTS_LIST_DETAIL_OK');

  // Edit: Save is disabled until something changes, then persists via the API.
  const save = page.getByRole('button', { name: 'Save', exact: true });
  assert.equal(await save.isDisabled(), true, 'Save is disabled without changes');
  await page.getByLabel('Project name', { exact: true }).fill('Alpha Renamed');
  await save.click();
  await page.locator('.pw-main [role="status"]').filter({ hasText: 'Saved' }).waitFor();
  assert.equal(rt.conversations.projects.get(alpha.id)?.name, 'Alpha Renamed');
  assert.equal(await page.locator('.pw-title').textContent(), 'Alpha Renamed');
  console.log('PROJECTS_EDIT_OK');

  // Create.
  await page.locator('#project-new').click();
  await page.getByLabel('Project name', { exact: true }).fill('Gamma');
  await page.getByLabel('Working directory', { exact: true }).fill(join(dir, 'gamma'));
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.locator('.pw-item-name', { hasText: 'Gamma' }).waitFor();
  const gamma = rt.conversations.projects.list().find(p => p.name === 'Gamma');
  assert.ok(gamma, 'Project created on the server');
  assert.equal(await page.locator('.pw-title').textContent(), 'Gamma', 'New project is selected after create');
  // Server errors show in the window.
  await page.locator('#project-new').click();
  await page.getByLabel('Project name', { exact: true }).fill('Bad');
  await page.getByLabel('Working directory', { exact: true }).fill('relative/dir');
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await page.locator('.pw-main [role="status"]').waitFor();
  assert.equal(rt.conversations.projects.list().some(p => p.name === 'Bad'), false);
  console.log('PROJECTS_CREATE_OK');

  // New chat in project closes the window and opens a session linked to that project.
  await page.locator(`.pw-item[data-project="${beta.id}"]`).click();
  await page.locator('#project-chat').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await (await fetch(`${url}/v1/sessions`)).json() as { sessions: { project: number | null }[] }).sessions.some(s => s.project === beta.id), false, 'Opening a project chat creates nothing yet');
  await page.locator('#input').fill('hello'); await page.locator('#send').click();
  await page.waitForFunction(() => (globalThis as any).document.querySelector('#title')?.textContent?.startsWith('Conversation'));
  const sessions = (await (await fetch(`${url}/v1/sessions`)).json() as { sessions: { id: number; project: number | null }[] }).sessions;
  assert.ok(sessions.some(s => s.project === beta.id && s.id !== seeded.id), 'New chat is linked to the project');
  console.log('PROJECTS_NEW_CHAT_OK');

  // Opening a recent conversation closes the window.
  await page.locator('[data-panel="projects"]').click();
  await page.locator(`.pw-item[data-project="${alpha.id}"]`).click();
  await page.locator('.pw-conv').first().click();
  await dialog.waitFor({ state: 'hidden' });

  // Delete keeps conversations.
  await page.locator('[data-panel="projects"]').click();
  await page.locator(`.pw-item[data-project="${gamma!.id}"]`).click();
  page.once('dialog', (d: any) => d.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator(`.pw-item[data-project="${gamma!.id}"]`).waitFor({ state: 'detached' });
  assert.equal(rt.conversations.projects.get(gamma!.id), undefined);
  console.log('PROJECTS_DELETE_OK');
  assert.deepEqual(errors, []);

  // Mobile: one pane at a time, back button returns to the list.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 800 } });
  mobile.setDefaultTimeout(8000);
  await mobile.goto(url);
  await mobile.locator('#menu').click();
  await mobile.locator('[data-panel="projects"]').click();
  await mobile.locator('.pw-item').first().waitFor();
  assert.equal(await mobile.locator('.pw-main').isVisible(), false, 'Mobile starts on the list');
  const mrect = (await mobile.locator('#panel [role="dialog"]').boundingBox())!;
  assert.ok(mrect.x >= 0 && mrect.x + mrect.width <= 390 && mrect.y >= 0 && mrect.y + mrect.height <= 800, 'Mobile window stays inside the viewport');
  await mobile.locator(`.pw-item[data-project="${beta.id}"]`).click();
  assert.equal(await mobile.locator('.pw-list').isVisible(), false);
  assert.equal(await mobile.locator('.pw-title').textContent(), 'Beta');
  await mobile.getByRole('button', { name: 'Back to projects', exact: true }).click();
  assert.equal(await mobile.locator('.pw-list').isVisible(), true);
  console.log('PROJECTS_MOBILE_OK');
} finally {
  await browser?.close();
  if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  await rt?.close?.();
  rmSync(dir, { recursive: true, force: true });
}
