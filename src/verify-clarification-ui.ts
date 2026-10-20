// Built UI regression: clarification forms use the conversation scroll, not a capped inner pane.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createWebApp } from './web-assets.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const model = { provider: 'fixture', modelId: 'chat' };
const options = Array.from({ length: 4 }, (_, i) => ({
  label: `Option ${i + 1}`,
  description: 'A detailed choice that must wrap naturally and remain readable on a narrow screen. '.repeat(3),
  ...(i === 0 ? { preview: 'A long preview line: ' + 'configuration_value_'.repeat(24) + '\n' + 'Preview detail\n'.repeat(18) } : {}),
}));
const question = (index: number) => ({ header: `Question ${index + 1}`, question: `Which target should I use for step ${index + 1}?`, options, multiSelect: index === 1 });
let questions: any[] = [];
const received: any[] = [];
const entries = [{ id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Please clarify these choices.', timestamp: Date.now() }] }];
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
function events(session = false) {
  let client: ReadableStreamDefaultController<Uint8Array>;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      client = controller;
      controller.enqueue(encoder.encode(': connected\n\n'));
      if (session) {
        clients.add(controller);
        controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify({ entries, run: null, inbox: [], tools: [], agent: { model } })}\n\n`));
      }
    },
    cancel() { clients.delete(client); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
const app = new Hono();
app.get('/health', c => c.json({ ok: true, auth: false }));
app.get('/v1/models', c => c.json({ default: model, models: [{ provider: 'fixture', id: 'chat', name: 'Chat' }] }));
app.get('/v1/projects', c => c.json({ projects: [] }));
app.get('/v1/sessions', c => c.json({ sessions: [{ id: 42, title: 'Clarifications' }] }));
app.get('/v1/events', () => events());
app.get('/v1/sessions/42/events', () => events(true));
app.get('/v1/sessions/42/context', c => c.json({ usedTokens: 0, contextWindow: 100000, percent: 0 }));
app.get('/v1/sessions/42', c => c.json({ id: 42, entries, agent: { model }, questions, todos: [], goal: null }));
app.post('/v1/sessions/42/questions/:callId', async c => {
  received.push(await c.req.json());
  questions = questions.filter(q => q.callId !== c.req.param('callId'));
  return c.json({ ok: true });
});
app.get('/v1/cron/*', c => c.json({ reports: [], jobs: [], runs: [], count: 0 }));
app.route('/', createWebApp(new URL('../dist/web/', import.meta.url)));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', resolve));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', (error: Error) => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('luna.session', '42'));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  for (const [width, height] of [[1200, 900], [393, 800], [320, 568], [800, 393], [393, 380]] as const) {
    questions = [{ callId: 'ask-layout', questions: Array.from({ length: 4 }, (_, i) => question(i)) }];
    await page.setViewportSize({ width, height });
    await page.goto(url);
    const form = page.locator('[data-ask="ask-layout"]');
    await form.waitFor({ state: 'attached' });
    assert.equal(await form.locator('.opt').count(), 16);
    // The whole form keeps its content height. Only the main conversation may scroll vertically.
    const layout = await form.evaluate((element: any) => {
      const g = globalThis as any, scrollContainers: string[] = [];
      for (let parent = element; parent; parent = parent.parentElement) {
        if (['auto', 'scroll'].includes(g.getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight + 1) scrollContainers.push(parent.id);
      }
      return { scrollContainers, formHeight: element.getBoundingClientRect().height,
        viewport: g.innerHeight, horizontalOverflow: g.document.documentElement.scrollWidth > g.innerWidth };
    });
    assert.deepEqual(layout.scrollContainers, ['log'], `${width}x${height}: no inner clarification scroll area`);
    assert.ok(layout.formHeight > layout.viewport, 'Long forms must retain their natural height');
    assert.equal(layout.horizontalOverflow, false);
    for (const option of await form.locator('.opt').all()) {
      assert.equal(await option.evaluate((element: any) => element.scrollWidth <= element.clientWidth + 1), true, 'Option text and preview must wrap');
    }
    const first = form.locator('input[type=radio]').first();
    await first.check();
    assert.equal(await first.isChecked(), true);
    const last = form.getByRole('button', { name: 'Answer', exact: true });
    await last.scrollIntoViewIfNeeded();
    const buttonBox = await last.boundingBox(), composeBox = await page.locator('#compose').boundingBox();
    assert.ok(buttonBox && composeBox && buttonBox.y >= 0 && buttonBox.y + buttonBox.height <= composeBox.y + 1, 'Answer stays reachable above the fixed composer');
    assert.ok(composeBox.y >= 0 && composeBox.y + composeBox.height <= height + 1, 'Composer remains in viewport');
    await page.screenshot({ path: `/tmp/luna-clarification-${width}x${height}.png` });
  }
  const form = page.locator('[data-ask="ask-layout"]');
  await form.locator('input[type=checkbox]').nth(0).check();
  await form.locator('input[type=checkbox]').nth(2).check();
  await form.getByPlaceholder('Or type your own answer').nth(2).fill('My custom target');
  await form.getByPlaceholder('Note for Luna (optional)').fill('Keep this note');
  await form.getByRole('button', { name: 'Answer', exact: true }).click();
  await form.waitFor({ state: 'detached' });
  assert.deepEqual(received.pop(), { answers: [
    { questionIndex: 0, kind: 'option', answer: 'Option 1' },
    { questionIndex: 1, kind: 'multi', selected: ['Option 1', 'Option 3'], answer: null },
    { questionIndex: 2, kind: 'custom', answer: 'My custom target' },
  ], globalNote: 'Keep this note' });
  // A newly arriving clarification also enters the real conversation scroll without a reload.
  questions = [{ callId: 'ask-live', questions: [question(0)] }];
  for (const client of clients) client.enqueue(encoder.encode(`event: tool_execution_start\ndata: ${JSON.stringify({ toolCallId: 'ask-live', toolName: 'ask_user_question', args: { questions: [question(0)] } })}\n\n`));
  const live = page.locator('#log [data-ask="ask-live"]');
  await live.waitFor({ state: 'attached' });
  await page.waitForFunction(() => {
    const g = globalThis as any;
    const form = g.document.querySelector('[data-ask="ask-live"]').getBoundingClientRect();
    const logElement = g.document.querySelector('#log');
    const log = logElement.getBoundingClientRect();
    return Math.abs(form.top - log.top - parseFloat(g.getComputedStyle(logElement).scrollPaddingTop)) < 2;
  });
  await page.setViewportSize({ width: 393, height: 800 });
  await live.locator('.row').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/luna-clarification-mobile-start.png' });
  await live.getByRole('button', { name: 'Decline', exact: true }).click();
  await live.waitFor({ state: 'detached' });
  assert.deepEqual(received.pop(), { cancelled: true });
  // Ordinary short questions remain fully visible when there is enough viewport space.
  questions = [{ callId: 'ask-short', questions: [{ header: 'Target', question: 'Which target?', options: [
    { label: 'Local', description: 'Use this machine.' }, { label: 'Remote', description: 'Use the remote machine.' },
  ] }] }];
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.reload();
  const short = page.locator('[data-ask="ask-short"]');
  await short.waitFor();
  await short.scrollIntoViewIfNeeded();
  const shortBox = await short.boundingBox(), logBox = await page.locator('#log').boundingBox();
  assert.ok(shortBox && logBox && shortBox.y >= logBox.y && shortBox.y + shortBox.height <= logBox.y + logBox.height, 'Short clarification fits without scrolling inside it');
  await page.screenshot({ path: '/tmp/luna-clarification-desktop-short.png' });
  assert.deepEqual(errors, []);
  console.log('CLARIFICATION_UI_OK: full-height forms, wrapped previews, conversation-only scroll, desktop/mobile/short viewport, selections/custom/note/decline, live arrival');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
