// Real built UI + real HTTP board routes + temporary SQLite. No external model calls.
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
const dir = mkdtempSync(join(process.cwd(), '.board-ui-'));
let rt: Awaited<ReturnType<typeof startRuntime>> | undefined, server: ReturnType<typeof serve> | undefined, browser: any, page: any;
try {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ dataDir: dir, provider: 'faux', model: 'main' }));
  const faux = fauxProvider({ models: [{ id: 'main' }] });
  const models = createModels(); models.setProvider(faux.provider);
  const m = faux.getModel();
  rt = await startRuntime(loadConfig(join(dir, 'config.json')), { models, model: { provider: m.provider, modelId: m.id } });
  const a = rt.conversations.projects.create('Alpha', dir);
  mkdirSync(join(dir, 'other'));
  const b = rt.conversations.projects.create('Beta', join(dir, 'other'));
  const card = rt.conversations.board.create(a.id, { subject: 'Drag this card', priority: 'high', labels: ['web'] });
  rt.conversations.board.create(a.id, { subject: 'Completed dependency', status: 'done' });
  const app = createApp({ harness: rt.harness, models: rt.models, providers: rt.providers, settings: rt.settings, conversations: rt.conversations, projectExtensions: rt.projectExtensions, agent: { model: { provider: m.provider, modelId: m.id } } });
  server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(r => server!.listening ? r() : server!.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--disable-gpu'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(url);
  await page.locator('[data-panel="board"]').click();
  await page.getByLabel('Project', { exact: true }).selectOption(String(a.id));
  const dialog = page.locator('#panel [role="dialog"]');
  const rect = await dialog.boundingBox();
  assert.ok(rect && rect.x >= 12 && rect.y >= 12 && rect.width >= 1440 * .9 && rect.height >= 1000 * .85, 'Board must float with margins and cover most of the viewport');
  console.log('BOARD_FLOATING_OK');
  const toolbar = page.locator('.kb-toolbar');
  assert.equal(await toolbar.getByLabel('Search cards', { exact: true }).count(), 1, 'Search belongs in the top toolbar');
  assert.equal(await toolbar.getByLabel('Filter priority', { exact: true }).count(), 1, 'Priority filter belongs in the top toolbar');
  const projectBox = await toolbar.getByLabel('Project', { exact: true }).boundingBox();
  const searchBox = await toolbar.getByLabel('Search cards', { exact: true }).boundingBox();
  const filterBox = await toolbar.getByLabel('Filter priority', { exact: true }).boundingBox();
  assert.ok(Math.abs(projectBox!.y - searchBox!.y) <= 4 && Math.abs(projectBox!.y - filterBox!.y) <= 4, 'Desktop project, search, and filter share one row');
  const boardBeforeMove = await page.locator('.kb-board').boundingBox();
  const statusBeforeMove = await page.locator('.kb-statusbar').boundingBox();
  assert.ok(statusBeforeMove && statusBeforeMove.y >= boardBeforeMove!.y + boardBeforeMove!.height, 'Feedback has a permanent bottom bar');
  const grip = page.getByRole('button', { name: `Drag card #${card.id}`, exact: true });
  await grip.waitFor();
  const start = await grip.boundingBox();
  const target = await page.locator('[data-column="review"]').boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 60, target!.y + 80, { steps: 20 });
  await page.locator('.kb-statusbar').getByRole('status').filter({ hasText: 'Drop #' }).waitFor();
  assert.deepEqual(await page.locator('.kb-board').boundingBox(), boardBeforeMove, 'Drag-target feedback cannot shift the board');
  await page.mouse.up();
  await page.locator(`[data-column="review"] [data-card="${card.id}"]`).waitFor();
  assert.equal(rt.conversations.board.get(a.id, card.id)?.status, 'review');
  await page.locator('.kb-statusbar').getByRole('status').filter({ hasText: 'moved to Review' }).waitFor();
  const boardAfterMove = await page.locator('.kb-board').boundingBox();
  assert.deepEqual(boardAfterMove, boardBeforeMove, 'Move feedback cannot shift or resize the board');
  assert.deepEqual(await page.locator('.kb-statusbar').boundingBox(), statusBeforeMove, 'Bottom feedback keeps the same dimensions');
  // Dragging from the top bar area outside the grip button (e.g. card ID) also moves the card.
  const topIdBox = await page.locator(`[data-card="${card.id}"] .kb-card-id`).boundingBox();
  const inProgBox = await page.locator('[data-column="in_progress"]').boundingBox();
  await page.mouse.move(topIdBox!.x + topIdBox!.width / 2, topIdBox!.y + topIdBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(inProgBox!.x + 60, inProgBox!.y + 80, { steps: 20 });
  await page.mouse.up();
  await page.locator(`[data-column="in_progress"] [data-card="${card.id}"]`).waitFor();
  assert.equal(rt.conversations.board.get(a.id, card.id)?.status, 'in_progress');
  // Dragging from the priority pill in the top bar back to review.
  const topPrioBox = await page.locator(`[data-card="${card.id}"] .kb-priority`).boundingBox();
  await page.mouse.move(topPrioBox!.x + topPrioBox!.width / 2, topPrioBox!.y + topPrioBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target!.x + 60, target!.y + 80, { steps: 20 });
  await page.mouse.up();
  await page.locator(`[data-column="review"] [data-card="${card.id}"]`).waitFor();
  assert.equal(rt.conversations.board.get(a.id, card.id)?.status, 'review');
  const styledCard = page.locator(`[data-card="${card.id}"]`);
  assert.equal(await styledCard.getAttribute('data-priority'), 'high');
  assert.equal(await styledCard.getAttribute('data-status'), 'review');
  assert.equal(await styledCard.locator('.kb-card-footer .kb-move').count(), 1, 'Move control is in a separate card footer');
  assert.ok(await styledCard.evaluate((el: any) => parseFloat((globalThis as any).getComputedStyle(el).borderLeftWidth) >= 3), 'Cards have a visible priority stripe');
  const highTone = await styledCard.locator('.kb-priority').evaluate((el: any) => (globalThis as any).getComputedStyle(el).color);
  const mediumTone = await page.locator('[data-column="done"] .kb-priority').first().evaluate((el: any) => (globalThis as any).getComputedStyle(el).color);
  assert.notEqual(highTone, mediumTone, 'Priority colors differ, with text labels retained');
  console.log('BOARD_TOOLBAR_FEEDBACK_CARD_HIERARCHY_OK');
  await page.locator('#pclose').click(); await page.locator('[data-panel="board"]').click();
  await page.locator(`[data-column="review"] [data-card="${card.id}"]`).waitFor();
  console.log('BOARD_DRAG_API_PERSISTENCE_OK');
  await page.getByRole('button', { name: 'New card', exact: true }).click();
  const editor = page.getByRole('form', { name: 'Card editor' });
  await editor.getByLabel('Card title', { exact: true }).fill('Full API card');
  await editor.getByLabel('Description', { exact: true }).fill('Description from the browser');
  await editor.getByLabel('Priority', { exact: true }).selectOption('urgent');
  await editor.getByLabel('Column', { exact: true }).selectOption('todo');
  await editor.getByLabel('Owner', { exact: true }).fill('m57');
  await editor.getByLabel('Labels', { exact: true }).fill('web, ui');
  await editor.getByLabel('Dependencies', { exact: true }).fill('#' + card.id);
  await editor.getByRole('button', { name: 'Save card', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const created = rt.conversations.board.list(a.id).find(c => c.subject === 'Full API card')!;
  assert.ok(created); assert.deepEqual(created.labels, ['web', 'ui']); assert.deepEqual(created.blockedBy, [card.id]);
  assert.equal(created.description, 'Description from the browser'); assert.equal(created.owner, 'm57'); assert.equal(created.priority, 'urgent'); assert.equal(created.status, 'todo');
  await page.locator(`[data-card="${created.id}"] .kb-card-title`).click();
  await editor.getByLabel('Card title', { exact: true }).fill('Edited API card');
  await editor.getByLabel('Dependencies', { exact: true }).fill('');
  await editor.getByLabel('Labels', { exact: true }).fill('');
  await editor.getByLabel('Owner', { exact: true }).fill('');
  await editor.getByRole('button', { name: 'Save card', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const updated = rt.conversations.board.get(a.id, created.id)!;
  assert.equal(updated.subject, 'Edited API card'); assert.deepEqual(updated.blockedBy, []); assert.deepEqual(updated.labels, []); assert.equal(updated.owner, null);
  await page.locator(`[data-card="${created.id}"] .kb-card-title`).click();
  await editor.getByRole('button', { name: 'Archive', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(rt.conversations.board.get(a.id, created.id)?.archived, true);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.locator(`.kb-archive-card[data-card="${created.id}"]`).click();
  await editor.getByRole('button', { name: 'Restore', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(rt.conversations.board.get(a.id, created.id)?.archived, false);
  await page.getByRole('button', { name: 'Back to board', exact: true }).click();
  await page.locator(`[data-card="${created.id}"] .kb-card-title`).click();
  page.once('dialog', (d: any) => d.accept());
  await editor.getByRole('button', { name: 'Delete', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
  assert.equal(rt.conversations.board.get(a.id, created.id), undefined);
  console.log('BOARD_ALL_CRUD_FIELDS_OK');
  // Real validation errors keep the draft available for correction.
  await page.getByRole('button', { name: 'Add card to To do', exact: true }).click();
  assert.equal(await editor.getByLabel('Column', { exact: true }).inputValue(), 'todo');
  await editor.getByLabel('Card title', { exact: true }).fill('Keep this draft');
  await editor.getByLabel('Dependencies', { exact: true }).fill('#99999');
  await editor.getByRole('button', { name: 'Save card', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'not found' }).waitFor();
  assert.equal(await editor.getByLabel('Card title', { exact: true }).inputValue(), 'Keep this draft');
  // Feed changes never replace a draft; cancel reloads the latest board.
  const synced = rt.conversations.board.create(a.id, { subject: 'Created by another session' }); rt.conversations.touch();
  await page.waitForTimeout(400);
  assert.equal(await editor.getByLabel('Card title', { exact: true }).inputValue(), 'Keep this draft');
  await page.keyboard.press('Escape');
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await dialog.isVisible(), true, 'Escape closes the editor before the board');
  await page.locator(`[data-card="${synced.id}"]`).waitFor();
  const more = rt.conversations.board.create(a.id, { subject: 'Live feed card', priority: 'urgent', labels: ['searchable'] }); rt.conversations.touch();
  await page.locator(`[data-card="${more.id}"]`).waitFor();
  await page.getByLabel('Search cards', { exact: true }).fill('searchable');
  assert.equal(await page.locator('.kb-card').count(), 1);
  await page.getByLabel('Search cards', { exact: true }).fill('');
  await page.getByLabel('Filter priority', { exact: true }).selectOption('urgent');
  assert.equal(await page.locator('.kb-card').count(), 1);
  await page.getByLabel('Filter priority', { exact: true }).selectOption('');
  // A failed write does not change the visible card or stored state.
  await page.route(`**/v1/projects/${a.id}/cards/${card.id}`, (route: any) => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Write unavailable. ' + 'Additional server detail. '.repeat(30) }) }) : route.continue());
  await page.getByLabel(`Move card #${card.id}`, { exact: true }).selectOption('done');
  await page.locator('.kb-statusbar').getByRole('alert').filter({ hasText: 'Write unavailable' }).waitFor();
  assert.deepEqual(await page.locator('.kb-board').boundingBox(), boardBeforeMove, 'Failed move feedback cannot shift the board');
  assert.equal(rt.conversations.board.get(a.id, card.id)?.status, 'review');
  assert.equal(await page.locator(`[data-column="review"] [data-card="${card.id}"]`).count(), 1);
  assert.equal(await page.getByLabel(`Move card #${card.id}`, { exact: true }).inputValue(), 'review', 'Failed dropdown write rolls back the control');
  await page.unroute(`**/v1/projects/${a.id}/cards/${card.id}`);
  await page.getByLabel(`Move card #${card.id}`, { exact: true }).selectOption('done');
  await page.locator(`[data-column="done"] [data-card="${card.id}"]`).waitFor();
  // Project isolation and late responses.
  await page.getByLabel('Project', { exact: true }).selectOption(String(b.id));
  await page.getByRole('button', { name: 'New card', exact: true }).waitFor();
  await page.waitForFunction(() => !(globalThis as any).document.querySelector('.kb-feedback')?.textContent?.includes('Loading'));
  assert.equal(await page.locator('.kb-card').count(), 0);
  await page.getByLabel('Project', { exact: true }).selectOption(String(a.id));
  await page.locator(`[data-card="${card.id}"]`).waitFor();
  console.log('BOARD_VALIDATION_SYNC_FAILURES_FILTERS_PROJECTS_OK');
  const screenshots = process.env.BOARD_SCREENSHOTS;
  if (screenshots) { mkdirSync(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, 'board-desktop.png') }); }
  // Small screens and high zoom: overflow stays inside the board, not the page/window.
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 400 }, { width: 800, height: 500 }]) {
    await page.setViewportSize(viewport);
    const dims = await dialog.boundingBox();
    assert.ok(dims && dims.x >= 7 && dims.y >= 7 && dims.x + dims.width <= viewport.width, 'Floating window fits small viewports');
    assert.equal(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
    const footerBox = await page.locator('.kb-statusbar').boundingBox();
    const workspaceBox = await page.locator('.kb-workspace').boundingBox();
    assert.ok(footerBox && footerBox.y >= workspaceBox!.y + workspaceBox!.height && footerBox.y + footerBox.height <= dims!.y + dims!.height, 'Bottom feedback remains below the board and inside the floating window');
    assert.equal(await page.locator('#board-body').evaluate((el: any) => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight), true, 'Board content cannot escape the window');
    await page.getByRole('button', { name: 'New card', exact: true }).click();
    await editor.getByLabel('Card title', { exact: true }).fill('Small-screen draft');
    if (viewport.width <= 760) assert.ok((await editor.boundingBox())!.height >= viewport.height * .65, 'Mobile editor has enough space, including with a short viewport');
    if (screenshots && viewport.width === 390 && viewport.height === 844) await page.screenshot({ path: join(screenshots, 'board-mobile-editor.png') });
    await page.getByRole('button', { name: 'Close card editor', exact: true }).click();
    assert.equal(await editor.count(), 0);
    await page.getByRole('button', { name: 'New card', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !((globalThis as any).document.querySelector('.kb-primary') as any)?.disabled);
    if (screenshots && viewport.width === 390 && viewport.height === 844) await page.screenshot({ path: join(screenshots, 'board-mobile.png') });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Long API-valid titles, owners, and labels wrap. Large columns scroll independently.
  rt.conversations.board.create(a.id, { subject: 'W'.repeat(200), owner: 'M'.repeat(100), labels: Array.from({ length: 20 }, (_, i) => String(i).padEnd(40, 'x')), priority: 'urgent' });
  for (let i = 0; i < 35; i++) rt.conversations.board.create(a.id, { subject: 'Overflow test ' + i });
  rt.conversations.touch();
  await page.locator('.kb-card').filter({ hasText: 'Overflow test 34' }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('[data-column="backlog"] .kb-cards').evaluate((el: any) => el.scrollHeight > el.clientHeight && el.scrollWidth <= el.clientWidth), true);
  console.log('BOARD_RESPONSIVE_LONG_CONTENT_SCROLL_OK');
  // Real browser touch events, edge autoscroll, cancellation, and server persistence.
  const touch = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  touch.setDefaultTimeout(8000);
  await touch.goto(url);
  await touch.locator('#menu').click(); await touch.locator('[data-panel="board"]').click();
  await touch.getByLabel('Project', { exact: true }).selectOption(String(a.id));
  const cdp = await touch.context().newCDPSession(touch);
  const tg = await touch.getByRole('button', { name: `Drag card #${more.id}`, exact: true }).boundingBox();
  const x = tg!.x + tg!.width / 2, y = tg!.y + tg!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 0; i < 20; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.min(365, x + i * 8), y: y + 10 }] }); await touch.waitForTimeout(20); }
  await touch.waitForTimeout(500);
  assert.equal(await touch.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true, 'Drag preview stays within the mobile viewport');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  assert.equal(rt.conversations.board.get(a.id, more.id)?.status, 'backlog', 'Touch cancel must not write');
  assert.equal(await touch.locator('.kb-ghost').count(), 0);
  await touch.locator('.kb-board').evaluate((el: any) => { el.scrollLeft = 0; });
  const t2 = await touch.getByRole('button', { name: `Drag card #${more.id}`, exact: true }).boundingBox();
  const x2 = t2!.x + t2!.width / 2, y2 = t2!.y + t2!.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x2, y: y2 }] });
  for (let i = 0; i < 20; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.min(365, x2 + i * 8), y: y2 + 10 }] }); await touch.waitForTimeout(20); }
  await touch.waitForTimeout(500); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.waitForFunction((id: number) => !(globalThis as any).document.querySelector(`[data-column="backlog"] [data-card="${id}"]`), more.id);
  assert.notEqual(rt.conversations.board.get(a.id, more.id)?.status, 'backlog');
  assert.equal(await touch.locator('.kb-ghost').count(), 0);
  console.log('BOARD_TOUCH_AUTOSCROLL_CANCEL_API_OK');
  await touch.close();
  await page.setViewportSize({ width: 3840, height: 1600 });
  assert.ok((await dialog.boundingBox())!.width >= 3840 * .9, 'Floating board also covers most of an ultrawide screen');
  await page.locator('#pclose').click();

  // ---- Composer # mention completion popup ----
  const mProj = rt.conversations.projects.create('Mention Project', dir);
  const mTodoLow = rt.conversations.board.create(mProj.id, { subject: 'Todo low item', status: 'todo', priority: 'low' });
  const mTodoUrgent = rt.conversations.board.create(mProj.id, { subject: 'Todo urgent item', status: 'todo', priority: 'urgent' });
  const mBacklogHigh = rt.conversations.board.create(mProj.id, { subject: 'Backlog high item', status: 'backlog', priority: 'high' });
  const mReviewMed = rt.conversations.board.create(mProj.id, { subject: 'Review medium item', status: 'review', priority: 'medium' });
  const mInProgHigh = rt.conversations.board.create(mProj.id, { subject: 'In progress high item', status: 'in_progress', priority: 'high' });
  const mDoneUrgent = rt.conversations.board.create(mProj.id, { subject: 'Done urgent item', status: 'done', priority: 'urgent' });
  const mSess = await (await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: mProj.id }),
  })).json() as { id: number };
  await page.evaluate(async (pid: number) => {
    localStorage.setItem('luna.project', String(pid));
  }, mProj.id);
  await page.reload();
  await page.locator(`[data-session="${mSess.id}"] .session-title`).click();
  const input = page.locator('#input');
  await input.click();
  await input.fill('Please check #');
  await input.dispatchEvent('input');
  const menu = page.locator('#mention-menu');
  await menu.waitFor({ state: 'visible' });

  // Category order must be: todo -> backlog -> review -> in_progress -> done
  const groupStatuses = await menu.locator('.mention-group').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-status')));
  assert.deepEqual(groupStatuses, ['todo', 'backlog', 'review', 'in_progress', 'done'], 'Categories sorted todo, backlog, review, in_progress, done');

  // Within todo, urgent comes before low; across all items, exact order matches category then priority
  const itemIds = await menu.locator('.mention-item').evaluateAll((els: any[]) => els.map(el => Number(el.getAttribute('data-card-id'))));
  assert.deepEqual(itemIds, [mTodoUrgent.id, mTodoLow.id, mBacklogHigh.id, mReviewMed.id, mInProgHigh.id, mDoneUrgent.id], 'Items sorted by category then priority');

  // Priority color dot indicator is present on each item
  assert.equal(await menu.locator('.mention-item .mention-priority-dot[data-priority="urgent"]').count(), 2);

  // Prefix filtering by number: typing #<digits> shows exact and longer prefix matches (e.g. #4 -> 4, 4x, 4xx)
  await input.fill('Please check ');
  await input.dispatchEvent('input');
  assert.equal(await menu.count(), 0);
  const prefixDigits = String(mTodoLow.id);
  const targetPrefix = Number(prefixDigits) * 10;
  let lastCreated = mDoneUrgent;
  while (lastCreated.id < targetPrefix - 1) {
    lastCreated = rt.conversations.board.create(mProj.id, { subject: 'Spacer item', status: 'backlog', priority: 'low' });
  }
  const mMultiA = rt.conversations.board.create(mProj.id, { subject: 'Multi digit A', status: 'todo', priority: 'high' });
  const mMultiB = rt.conversations.board.create(mProj.id, { subject: 'Multi digit B', status: 'review', priority: 'urgent' });
  await page.reload();
  await page.locator(`[data-session="${mSess.id}"] .session-title`).click();
  await input.click();
  await input.fill(`Look at #${prefixDigits}`);
  await input.dispatchEvent('input');
  await menu.locator(`.mention-item[data-card-id="${mMultiA.id}"]`).waitFor({ state: 'visible' });
  const filteredIds = await menu.locator('.mention-item').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-card-id') || ''));
  assert.ok(filteredIds.includes(prefixDigits) && filteredIds.includes(String(mMultiA.id)) && filteredIds.includes(String(mMultiB.id)), 'Number after # shows exact and longer prefix matches');
  assert.ok(filteredIds.every((id: string) => id.startsWith(prefixDigits)), 'Number after # filters strictly by id prefix');

  // Selecting an item with Enter inserts #<id> into the chat box
  await input.fill(`Implement #${mReviewMed.id}`);
  await input.dispatchEvent('input');
  await menu.locator(`.mention-item[data-card-id="${mReviewMed.id}"]`).waitFor({ state: 'visible' });
  await input.press('Enter');
  assert.equal(await input.inputValue(), `Implement #${mReviewMed.id} `);
  assert.equal(await menu.count(), 0, 'Menu closes after selecting mention');
  await page.evaluate((pid: number) => {
    localStorage.setItem('luna.project', String(pid));
  }, a.id);
  console.log('BOARD_MENTION_AUTOCOMPLETE_OK');

  // Slash command autocomplete popup when typing / at start of input
  const cmdMenu = page.locator('#command-menu');
  await input.fill('/');
  await input.dispatchEvent('input');
  await cmdMenu.waitFor({ state: 'visible' });
  const cmdGroups = await cmdMenu.locator('.command-group').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-category')));
  assert.deepEqual(cmdGroups, ['side', 'busy', 'session']);
  const allCmds = await cmdMenu.locator('.command-item').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-command')));
  assert.deepEqual(allCmds, ['btw', 'bg', 'learn', 'queue', 'steer', 'redirect', 'queue list', 'queue edit', 'queue remove', 'queue move', 'queue clear', 'stop']);

  // Prefix filtering (e.g. /b -> btw, bg; /queue -> queue & queue subcommands)
  await input.fill('/b');
  await input.dispatchEvent('input');
  const bCmds = await cmdMenu.locator('.command-item').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-command')));
  assert.deepEqual(bCmds, ['btw', 'bg']);
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '/bg ');
  assert.equal(await cmdMenu.count(), 0, 'Command menu closes after selecting command');

  await input.fill('/queue m');
  await input.dispatchEvent('input');
  await cmdMenu.waitFor({ state: 'visible' });
  const qCmds = await cmdMenu.locator('.command-item').evaluateAll((els: any[]) => els.map(el => el.getAttribute('data-command')));
  assert.deepEqual(qCmds, ['queue move']);
  await input.press('Tab');
  assert.equal(await input.inputValue(), '/queue move ');
  assert.equal(await cmdMenu.count(), 0);
  await input.fill('');
  await input.dispatchEvent('input');
  console.log('SLASH_COMMAND_AUTOCOMPLETE_OK');

  await page.route(`**/v1/projects/${mProj.id}/board`, (route: any) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Board read unavailable' }) }));
  await page.locator('[data-panel="board"]').click();
  await page.getByRole('alert').filter({ hasText: 'Board read unavailable' }).waitFor();
  await page.unroute(`**/v1/projects/${mProj.id}/board`);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.locator(`[data-card="${mTodoLow.id}"]`).waitFor();
  await page.locator('#pclose').click();
  await page.route('**/v1/projects', (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: [] }) }));
  await page.locator('[data-panel="board"]').click();
  await page.getByText('Create a project to use its board.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New card', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Open projects', exact: true }).click();
  await page.locator('#ptitle').filter({ hasText: 'Projects' }).waitFor();
  console.log('BOARD_ULTRAWIDE_READ_RETRY_EMPTY_OK');
  assert.equal(errors.length, 0, errors.join('\n'));
} catch (e) {
  if (page) { console.error('BOARD_FAILURE_STATE', await page.locator('.kb-statusbar').textContent().catch(() => 'Panel unavailable')); await page.screenshot({ path: '/tmp/board-failure.png' }); }
  throw e;
} finally {
  await browser?.close();
  if (server) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  await rt?.close?.();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
