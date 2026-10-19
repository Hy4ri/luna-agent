// Deterministic browser gate. Real built UI and SSE; fixture data replaces external model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createWebApp } from './web-assets.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const stamp = 1760000000000;
const model = { provider: 'fixture', modelId: 'chat' };
const context = { usedTokens: 24000, contextWindow: 100000, percent: 24, triggerPercent: 75, autoCompactionEnabled: true };
const usage = { models: { 'fixture/chat': { input: 10000, output: 2500, cacheRead: 3000, cost: { total: 0.125 } } } };
const failedText = 'Permission denied <script>window.injected = true</script>';
const initialEntries = [
  { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Read these files', timestamp: stamp }] },
  { id: 2, kind: 'pi.assistant', model: [{ role: 'assistant', timestamp: stamp + 1000, content: [
    { type: 'text', text: 'Checking the files.' }, { type: 'thinking', thinking: 'Compare the file names.' },
    { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.txt' } },
  ] }] },
  { id: 3, kind: 'pi.tool', model: [{ role: 'toolResult', toolCallId: 'read-1', toolName: 'read', isError: true, timestamp: stamp + 2000, content: [{ type: 'text', text: failedText }] }] },
  { id: 4, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: 'One file needs access.' }], timestamp: stamp + 3000 }] },
  { id: 5, kind: 'pi.user', model: [{ role: 'user', content: 'Background process deadbeef-abcd finished: completed, exit 0.\nWorker report.', timestamp: stamp + 4000 }] },
  { id: 6, kind: 'pi.user', model: [{ role: 'user', content: 'I mentioned background tasks, not a report.', timestamp: stamp + 5000 }] },
];
const tasks = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, activeForm: i === 1 ? 'Reading files' : undefined, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending', blockedBy: [] }));
const sessions = new Map<string, any>([
  ['42', { project: 7, entries: initialEntries, todos: tasks }],
  ['43', { project: null, entries: [], todos: tasks.slice(0, 2) }],
]);
const clients = new Map<string, Set<ReadableStreamDefaultController<Uint8Array>>>();
const encoder = new TextEncoder();
function emit(id: string, type: string, data: unknown) {
  for (const client of clients.get(id) || []) client.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
}
function stream(id: string, snapshot?: unknown) {
  let client: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      client = controller;
      if (!clients.has(id)) clients.set(id, new Set());
      clients.get(id)!.add(controller);
      controller.enqueue(encoder.encode(': connected\n\n'));
      if (snapshot) emit(id, 'snapshot', snapshot);
    },
    cancel() { clients.get(id)?.delete(client); },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
}
const snapshot = (id: string) => ({ entries: sessions.get(id)?.entries || [], run: null, generation: null, inbox: [], tools: [], nestedTools: [], compactions: [], agent: { model }, usage });
const app = new Hono();
app.get('/health', c => c.json({ ok: true, auth: false }));
app.get('/v1/models', c => c.json({ default: model, models: [{ provider: 'fixture', id: 'chat', name: 'Chat model', reasoning: true }] }));
app.get('/v1/projects', c => c.json({ projects: [{ id: 7, name: 'Active project', cwd: '/tmp' }, { id: 9, name: 'Different project', cwd: '/tmp' }] }));
app.get('/v1/sessions', c => c.json({ sessions: [...sessions].map(([id, s]) => ({ id: Number(id), title: `Chat ${id}`, project: s.project })) }));
let failCreate = false, nextId = 44;
const creations: any[] = [], messages: any[] = [];
app.post('/v1/sessions', async c => {
  const body = await c.req.json(); creations.push(body);
  if (failCreate) return c.json({ error: 'Fixture creation failed' }, 503);
  const id = String(nextId++); sessions.set(id, { project: body.project ?? null, entries: [], todos: [] });
  return c.json({ id: Number(id) }, 201);
});
app.get('/v1/events', () => stream('list'));
app.get('/v1/sessions/:id/events', c => stream(c.req.param('id'), snapshot(c.req.param('id'))));
app.get('/v1/sessions/:id/context', c => c.json(context));
app.get('/v1/sessions/:id', c => c.json({ ...sessions.get(c.req.param('id')), id: Number(c.req.param('id')), agent: { model }, usage, contextUsage: context, questions: [], goal: null }));
app.post('/v1/sessions/:id/messages', async c => {
  messages.push(await c.req.json());
  return c.json({ tip: 'Busy input: redirect the current model request; during tools, add the message after the tool batch. Use /queue, /steer, or /redirect to override.', notice: 'Queued.' });
});
app.post('/v1/sessions/:id/abort', c => { emit(c.req.param('id'), 'run_end', {}); return c.json({ ok: true }); });
app.get('/v1/cron/*', c => c.json({ reports: [], jobs: [], runs: [], count: 0 }));
app.route('/', createWebApp(new URL('../dist/web/', import.meta.url)));
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
let browser: any;
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-gpu'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const errors: string[] = []; page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.addInitScript(() => { localStorage.setItem('luna.session', '42'); localStorage.setItem('luna.project', '9'); });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  await page.locator('.user').filter({ hasText: 'Read these files' }).waitFor();
  await page.locator('#new-session').waitFor();
  assert.equal(await page.locator('#send').isDisabled(), true, 'Empty idle Send is disabled');
  assert.equal((await page.locator('#send').textContent()).trim(), '', 'Send is icon-only');
  assert.equal(await page.locator('#top #stop').count(), 0);
  assert.equal(await page.locator('#log').getAttribute('tabindex'), null);
  assert.equal(await page.locator('.compose-hint').count(), 0);
  assert.equal(await page.locator('#status').count(), 0);
  const reasoning = page.locator('.thinking').first();
  assert.equal(await reasoning.getAttribute('open'), null, 'Reasoning defaults collapsed');
  await reasoning.locator('summary').click();
  await reasoning.getByText('Compare the file names.', { exact: true }).waitFor();
  assert.equal(await page.locator('.background-report').count(), 1);
  assert.equal(await page.locator('.user').count(), 2, 'Synthetic reports are not user messages');
  assert.equal(await page.locator('.user').filter({ hasText: 'I mentioned background tasks' }).count(), 1);
  const failed = page.locator('.tool[data-call="read-1"]');
  assert.equal(await failed.getAttribute('data-state'), 'failed');
  const details = failed.locator('details');
  if (await details.count()) await details.evaluate((el: any) => { el.open = false; });
  else await failed.evaluate((el: any) => { el.open = false; });
  await failed.getByText(failedText, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await failed.locator('script').count(), 0);
  assert.equal(await page.evaluate(() => (globalThis as any).injected), undefined);
  assert.ok(await failed.locator('time').count(), 'Tool timestamp remains at bottom');
  for (const row of [page.locator('.user').first(), page.locator('.assistant').filter({ hasText: 'One file needs access.' })]) {
    assert.ok(await row.locator('.message-footer time').getAttribute('datetime'));
    await row.getByRole('button', { name: 'Copy message', exact: true }).waitFor();
  }
  await page.evaluate("globalThis.copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { globalThis.copied = text; } } })");
  await page.locator('.user').first().getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => (globalThis as any).copied), 'Read these files');
  await page.locator('.assistant').filter({ hasText: 'One file needs access.' }).getByRole('button', { name: 'Copy message', exact: true }).click();
  assert.equal(await page.evaluate(() => (globalThis as any).copied), 'One file needs access.');
  await page.evaluate("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })");
  await page.locator('.user').first().getByRole('button', { name: 'Copy message', exact: true }).click();
  await page.locator('.user').first().getByText('Copied to clipboard', { exact: true }).waitFor({ state: 'attached' });
  await page.evaluate("document.execCommand = () => false");
  await page.locator('.user').first().getByRole('button', { name: 'Copy message', exact: true }).click();
  await page.locator('.user').first().getByText('Failed to copy', { exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.locator('textarea[aria-hidden="true"]').count(), 0, 'Clipboard fallback always removes its temporary node');
  const todo = page.locator('.todo');
  assert.equal(await todo.getAttribute('open'), null);
  assert.ok((await todo.boundingBox()).height < 60, 'Collapsed tasks use one row');
  tasks[1]!.activeForm = 'Checking files';
  emit('42', 'submission', { record: { status: 'done' } });
  await todo.locator('summary').filter({ hasText: 'Checking files' }).waitFor();
  assert.equal(await todo.getAttribute('open'), null, 'Polling cannot open tasks');
  await todo.locator('summary').click();
  tasks[1]!.activeForm = 'Checking more files'; emit('42', 'submission', { record: { status: 'done' } });
  await todo.locator('summary').filter({ hasText: 'Checking more files' }).waitFor();
  assert.notEqual(await todo.getAttribute('open'), null, 'Polling preserves user expansion');
  assert.ok((await todo.locator('.todo-list').boundingBox()).height <= 170);
  await todo.locator('summary').click();
  assert.equal(await page.locator('#top #statusbar').count(), 1);
  assert.equal(await page.locator('#statusbar').getAttribute('open'), null);
  await page.locator('#statusbar > summary').click();
  await page.locator('#context-meter').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#context-meter').getAttribute('aria-valuenow'), '24');
  assert.match(await page.locator('#usage').textContent(), /13.0k in.*2.5k out/);
  await page.locator('#statusbar > summary').click();
  emit('42', 'run_start', {}); emit('42', 'turn_start', {});
  await page.locator('#activity').filter({ hasText: 'Thinking' }).waitFor();
  await page.locator('#stop').waitFor(); assert.equal(await page.locator('#send').isVisible(), false);
  await page.locator('#input').fill('Next instruction');
  await page.locator('#send').waitFor({ state: 'visible' });
  const stopBox = await page.locator('#stop').boundingBox(), sendBox = await page.locator('#send').boundingBox();
  assert.ok(stopBox.x < sendBox.x && Math.abs(stopBox.y - sendBox.y) < 3, 'Stop is immediately left of Send');
  await page.locator('#send').click();
  await page.locator('#busyFeedback').filter({ hasText: 'Queued.' }).waitFor();
  assert.ok(!(await page.locator('#busyFeedback').textContent()).includes('Busy input:'));
  assert.equal(messages[0].content, 'Next instruction');
  await page.locator('#file').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64') });
  await page.locator('#send').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#send').isDisabled(), false, 'Attachment-only draft can send');
  await page.getByRole('button', { name: 'Remove attached image 1' }).click();
  emit('42', 'message_start', { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Live reasoning example.' }] } });
  await page.locator('.thinking').filter({ hasText: 'Live reasoning example.' }).waitFor({ state: 'attached' });
  emit('42', 'tool_execution_start', { toolCallId: 'live-1', toolName: 'bash', taskId: 't-1', args: { command: 'false' } });
  emit('42', 'tool_execution_update', { toolCallId: 'live-1', output: { set: 'stale partial output' } });
  await page.locator('.tool[data-call="live-1"]').waitFor();
  await page.locator('.tool[data-call="live-1"] summary').click();
  await page.evaluate(() => { (globalThis as any).savedTool = (globalThis as any).document.querySelector('.tool[data-call="live-1"]'); });
  emit('42', 'tool_execution_update', { toolCallId: 'live-1', output: { append: ' more output' } });
  await page.locator('.tool[data-call="live-1"] pre').filter({ hasText: 'more output' }).waitFor();
  assert.equal(await page.evaluate(() => (globalThis as any).savedTool === (globalThis as any).document.querySelector('.tool[data-call="live-1"]')), true);
  assert.notEqual(await page.locator('.tool[data-call="live-1"] details').getAttribute('open'), null);
  emit('42', 'tool_execution_end', { toolCallId: 'live-1', result: { isError: true, structuredOutput: 'Final tool error', diagnostics: [] } });
  const finalTool = page.locator('.tool[data-call="live-1"]');
  await finalTool.getByText('Final tool error', { exact: true }).waitFor();
  assert.ok(!(await finalTool.textContent()).includes('stale partial output'));
  emit('42', 'tool_execution_start', { toolCallId: 'fault-1', toolName: 'read', taskId: 'task-fault', args: {} });
  await page.locator('.tool[data-call="fault-1"]').waitFor();
  emit('42', 'task_failed', { taskId: 'task-fault', kind: 'tool', message: 'Tool task fault' });
  await page.locator('.tool[data-call="fault-1"]').getByText('Tool task fault', { exact: true }).waitFor();
  assert.equal(await page.locator('#log > .msg.err').filter({ hasText: 'Tool task fault' }).count(), 0);
  emit('42', 'run_end', {});
  await page.locator('#activity').waitFor({ state: 'hidden' });
  assert.ok((await finalTool.boundingBox()).height > 60, 'Completed tool cards must not shrink into blank lines');
  async function verifyJumpButtons() {
    // Force real layout overflow without replacing browser scroll metrics.
    await page.locator('#log > .msg').first().evaluate((el: any) => { el.style.minHeight = '3000px'; });
    await page.locator('#log').evaluate((el: any) => { el.scrollTop = 500; el.dispatchEvent(new Event('scroll')); });
    const up = page.getByRole('button', { name: 'Jump to top', exact: true });
    const down = page.getByRole('button', { name: 'Jump to bottom', exact: true });
    await up.waitFor(); await down.waitFor();
    assert.equal(await up.textContent(), '', 'Top uses an icon, not visible text');
    assert.equal(await down.textContent(), '', 'Bottom uses an icon, not visible text');
    assert.equal(await up.locator('svg').count(), 1);
    assert.equal(await down.locator('svg').count(), 1);
    await up.click();
    await page.waitForFunction(() => (globalThis as any).document.getElementById('log').scrollTop === 0);
    assert.equal(await up.isVisible(), false);
    await down.click();
    await page.waitForFunction(() => {
      const log = (globalThis as any).document.getElementById('log');
      return log.scrollHeight - log.scrollTop - log.clientHeight < 2;
    });
    assert.equal(await down.isVisible(), false);
    await up.waitFor();
    await page.locator('#log > .msg').first().evaluate((el: any) => { el.style.minHeight = ''; });
  }
  await verifyJumpButtons();
  await page.screenshot({ path: '/tmp/luna-chat-desktop.png' });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => (globalThis as any).document.getElementById('side').getBoundingClientRect().right <= 0);
    assert.equal(await page.evaluate(() => (globalThis as any).document.documentElement.scrollWidth <= (globalThis as any).innerWidth), true);
    assert.equal(await page.locator('#main').evaluate((el: any) => el.scrollWidth <= el.clientWidth + 1), true, `No chat overflow at ${width}px`);
    const summary = await page.locator('#statusbar > summary').textContent(); assert.ok(summary.trim(), 'Mobile usage control cannot be blank');
    await verifyJumpButtons();
  }
  await page.screenshot({ path: '/tmp/luna-chat-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#new-session').click();
  await page.waitForFunction(() => localStorage.getItem('luna.session') === '44');
  assert.deepEqual(creations[0], { project: 7 }, 'Header + uses active project, not saved project');
  await page.evaluate(() => (globalThis as any).openSession('43'));
  await page.locator('.todo').waitFor(); assert.equal(await page.locator('.todo').getAttribute('open'), null, 'Session switch resets tasks');
  await page.locator('#new-session').click(); await page.waitForFunction(() => localStorage.getItem('luna.session') === '45');
  assert.deepEqual(creations[1], {}, 'Projectless conversation stays projectless');
  failCreate = true; await page.locator('#new-session').click();
  await page.getByText('Fixture creation failed', { exact: true }).waitFor();
  assert.equal(await page.locator('#new-session').isDisabled(), false, 'Creation failure unlocks +');
  assert.equal(await page.evaluate(() => localStorage.getItem('luna.session')), '45');
  failCreate = false;
  await page.evaluate(() => (globalThis as any).openSession('44'));
  await page.locator('[data-session="44"] .session-open[aria-current="page"]').waitFor();
  sessions.get('44').project = null; emit('list', 'sessions_changed', {});
  await page.locator('.session-group[data-project="none"] [data-session="44"]').waitFor();
  await page.locator('#new-session').click(); await page.waitForFunction(() => localStorage.getItem('luna.session') === '46');
  assert.deepEqual(creations[3], {}, 'Deleted project links cannot leak into new sessions');
  assert.deepEqual(errors, []);
  console.log('CHAT_VIEW_UI_OK: controls, project scope, reasoning, tools/errors, reports, copy/time, tasks, activity, usage, mobile');
} finally {
  await browser?.close();
  for (const set of clients.values()) for (const client of set) { try { client.close(); } catch {} }
  (server as any).closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
