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
  { id: 7, kind: 'pi.assistant', model: [{ role: 'assistant', timestamp: stamp + 6000, content: [
    { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'const a = 1;', newText: 'const a = 2;\nconst b = 3;' }] } },
    { type: 'toolCall', id: 'edit-2', name: 'edit', arguments: { path: 'src/b.ts', edits: [{ oldText: 'old line', newText: 'new line' }] } },
    { type: 'toolCall', id: 'bash-1', name: 'bash', arguments: { command: 'pnpm test\n--verbose' } },
  ] }] },
  { id: 8, kind: 'pi.tool', model: [
    { role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', isError: false, timestamp: stamp + 7000, content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in src/a.ts.' }],
      details: { diff: '    ...\n  9 // keep\n-10 const a = 1;\n+10 const a = 2;\n+11 const b = 3;\n 11 export {};', patch: '' } },
    { role: 'toolResult', toolCallId: 'edit-2', toolName: 'edit', isError: true, timestamp: stamp + 7000, content: [{ type: 'text', text: 'Could not find the exact text in src/b.ts.' }] },
    { role: 'toolResult', toolCallId: 'bash-1', toolName: 'bash', isError: true, timestamp: stamp + 7000, content: [{ type: 'text', text: '\u001b[31mFAIL\u001b[0m 2 tests\n<harness>\n[error] Command exited with code 2\n</harness>' }] },
  ] },
  { id: 9, kind: 'pi.assistant', model: [{ role: 'assistant', timestamp: stamp + 8000, content: [
    { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'notes.md', content: 'one\ntwo\nthree\n' } },
    { type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: 'src/c.ts', offset: 120, limit: 2 } },
    { type: 'toolCall', id: 'proc-1', name: 'process_start', arguments: { command: 'pnpm build' } },
    { type: 'toolCall', id: 'todo-1', name: 'todo', arguments: { action: 'update', id: 2, status: 'completed' } },
    { type: 'toolCall', id: 'search-1', name: 'web_search', arguments: { query: 'pi durable' } },
    { type: 'toolCall', id: 'extract-1', name: 'web_extract', arguments: { url: 'https://example.com/a' } },
    { type: 'toolCall', id: 'ask-1', name: 'ask_user_question', arguments: { questions: [{ question: 'Which scope?', header: 'Scope', options: [] }] } },
    { type: 'toolCall', id: 'skill-1', name: 'skill_view', arguments: { name: 'luna-dev' } },
    { type: 'toolCall', id: 'board-1', name: 'board', arguments: { action: 'update', id: 49, status: 'done' } },
    { type: 'toolCall', id: 'click-1', name: 'browser_click', arguments: { tabId: 't', ref: 'e12' } },
    { type: 'toolCall', id: 'mcp-1', name: 'mcp__x__lookup', arguments: { q: 'z' } },
  ] }] },
  { id: 10, kind: 'pi.tool', model: [
    { role: 'toolResult', toolCallId: 'write-1', toolName: 'write', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'Successfully wrote to notes.md' }] },
    { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'line a\nline b\n<harness>\n[info] Showing lines 120-121 of 300. Use offset=122 to continue.\n</harness>' }] },
    { role: 'toolResult', toolCallId: 'proc-1', toolName: 'process_start', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: JSON.stringify({ id: 'abc', running: false, status: 'exited', command: 'pnpm build', exitCode: 1, output: 'built\n\u001b[31merror\u001b[0m', truncated: false }) }] },
    { role: 'toolResult', toolCallId: 'todo-1', toolName: 'todo', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'Updated #2 (in_progress → completed)' }],
      details: { tasks: [{ id: 1, subject: 'Plan', status: 'completed' }, { id: 2, subject: 'Build', status: 'in_progress', activeForm: 'Building' }, { id: 3, subject: 'Gone', status: 'deleted' }, { id: 4, subject: 'Ship', status: 'pending' }] } },
    { role: 'toolResult', toolCallId: 'search-1', toolName: 'web_search', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: JSON.stringify({ results: [{ title: 'Pi docs', url: 'https://www.example.com/docs', snippet: 'Durable runtime.' }, { title: 'Bad', url: 'javascript:alert(1)', snippet: '' }] }) }] },
    { role: 'toolResult', toolCallId: 'extract-1', toolName: 'web_extract', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: JSON.stringify({ url: 'https://example.com/a', content: 'Page body text.' }) }] },
    { role: 'toolResult', toolCallId: 'ask-1', toolName: 'ask_user_question', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'User has answered.' }], details: { answers: [{ questionIndex: 0, question: 'Which scope?', kind: 'option', answer: 'All tools' }] } },
    { role: 'toolResult', toolCallId: 'skill-1', toolName: 'skill_view', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: '# Skill: luna-dev\n\nUse **this** skill.' }] },
    { role: 'toolResult', toolCallId: 'board-1', toolName: 'board', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'Updated #49 [done|medium]' }] },
    { role: 'toolResult', toolCallId: 'click-1', toolName: 'browser_click', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'Clicked.' }] },
    { role: 'toolResult', toolCallId: 'mcp-1', toolName: 'mcp__x__lookup', isError: false, timestamp: stamp + 9000, content: [{ type: 'text', text: 'found' }] },
  ] },
];
const tasks = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, subject: `Task ${i + 1}`, activeForm: i === 1 ? 'Reading files' : undefined, status: i === 0 ? 'completed' : i === 1 ? 'in_progress' : 'pending', blockedBy: [] }));
const sessions = new Map<string, any>([
  ['42', { project: 7, entries: initialEntries, todos: tasks, processes: [
    { id: 'p-live', running: true, status: 'running', command: 'pnpm run build --watch\nsecond line', createdAt: Date.now() - 65000, exitCode: null },
    { id: 'p-fail', running: false, status: 'failed', command: 'pnpm test', createdAt: stamp, finishedAt: stamp + 4000, exitCode: 2 },
  ], children: [
    { id: 90, task: 'Write blind tests for the parser', status: 'running', statusReason: null },
    { id: 91, task: 'Review the diff', status: 'finished', statusReason: null },
  ] }],
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
const snapshot = (id: string) => ({ entries: (sessions.get(id) ?? childSessions.get(id))?.entries || [], run: null, generation: null, inbox: [], tools: [], nestedTools: [], compactions: [], agent: { model }, usage });
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
const childSessions = new Map<string, any>([['90', { project: null, entries: [], todos: [] }]]);
app.get('/v1/sessions/:id', c => c.json({ ...(sessions.get(c.req.param('id')) ?? childSessions.get(c.req.param('id'))), id: Number(c.req.param('id')), agent: { model }, usage, contextUsage: context, questions: [], goal: null }));
app.post('/v1/sessions/:id/messages', async c => {
  messages.push(await c.req.json());
  return c.json({ tip: 'Busy input: redirect the current model request; during tools, add the message after the tool batch. Use /queue, /steer, or /redirect to override.', notice: 'Queued.' });
});
const aborts: string[] = [], processStops: string[] = [], processReads: string[] = [];
app.post('/v1/sessions/:id/abort', c => { aborts.push(c.req.param('id')); emit(c.req.param('id'), 'run_end', {}); return c.json({ ok: true }); });
app.get('/v1/sessions/:id/processes/:pid', c => { processReads.push(c.req.param('pid')); return c.json({ id: c.req.param('pid'), running: true, output: 'compiled 12 modules\n<b>not html</b>', offset: 0, truncated: false }); });
app.post('/v1/sessions/:id/processes/:pid/stop', c => { processStops.push(c.req.param('id') + ':' + c.req.param('pid')); return c.json({ id: c.req.param('pid'), status: 'stopped' }); });
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
  // Run failures must not remain pinned below later, successful turns.
  const modelError = 'model_error: The service is currently unavailable.';
  emit('42', 'task_failed', { taskId: 'generation-failure', message: modelError });
  const notice = page.locator('#log > .msg.err').filter({ hasText: modelError });
  await notice.waitFor();
  emit('42', 'run_end', {});
  await notice.getByRole('button', { name: 'Dismiss notice' }).click();
  await notice.waitFor({ state: 'detached' });
  emit('42', 'task_failed', { taskId: 'generation-failure-2', message: modelError });
  await notice.waitFor();
  emit('42', 'run_start', {});
  await notice.waitFor({ state: 'detached' });
  emit('42', 'submission', { record: { status: 'unanswered', reason: 'model_error', detail: 'Retry unavailable' } });
  const retryNotice = page.locator('#log > .msg.err').filter({ hasText: 'Retry unavailable' });
  await retryNotice.waitFor();
  emit('42', 'compaction_end', { taskId: 'compact-failure', error: 'Compaction unavailable' });
  const compactionNotice = page.locator('#log > .msg.err').filter({ hasText: 'Compaction unavailable' });
  await compactionNotice.waitFor();
  emit('42', 'turn_start', {});
  await retryNotice.waitFor({ state: 'detached' });
  assert.equal(await compactionNotice.count(), 1, 'A model retry must not hide unrelated errors');
  await compactionNotice.getByRole('button', { name: 'Dismiss notice' }).click();
  await compactionNotice.waitFor({ state: 'detached' });
  emit('42', 'run_end', {});
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
  const details = failed.locator(':scope > details');
  if (await details.count()) await details.evaluate((el: any) => { el.open = false; });
  else await failed.evaluate((el: any) => { el.open = false; });
  await failed.getByText(failedText, { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await failed.locator('script').count(), 0);
  assert.equal(await page.evaluate(() => (globalThis as any).injected), undefined);
  assert.ok(await failed.locator('time').count(), 'Tool timestamp remains at bottom');
  const edit = page.locator('.tool[data-call="edit-1"]');
  assert.equal((await edit.locator('.tool-summary').textContent()).trim(), 'src/a.ts', 'Edit summary names the file');
  assert.equal((await edit.locator('.tool-counts').textContent()).trim(), '+2 −1');
  await edit.locator('summary').first().click();
  await edit.getByText('Diff', { exact: true }).waitFor();
  assert.deepEqual(await edit.locator('.diff-row').evaluateAll((rows: any[]) => rows.map(r => [r.dataset.kind, r.querySelector('.diff-line').textContent, r.querySelector('.diff-text').textContent])),
    [['skip', '', '…'], ['ctx', '9', '// keep'], ['del', '10', 'const a = 1;'], ['add', '10', 'const a = 2;'], ['add', '11', 'const b = 3;'], ['ctx', '11', 'export {};']]);
  assert.equal(await edit.locator('.tool-section-label', { hasText: 'Arguments' }).count(), 0, 'Edit shows a diff, not argument JSON');
  assert.equal(await edit.locator('.tool-raw').count(), 1, 'Raw arguments stay reachable');
  const open = async (call: string) => { const tool = page.locator(`.tool[data-call="${call}"]`); await tool.locator(':scope > details > summary').click(); return tool; };
  const write = await open('write-1');
  assert.equal((await write.locator('.tool-counts').textContent()).trim(), '3 lines');
  assert.deepEqual(await write.locator('.code-row').evaluateAll((r: any[]) => r.map(x => x.textContent)), ['1one', '2two', '3three']);
  const read2 = await open('read-2');
  assert.equal((await read2.locator('.tool-summary').textContent()).trim(), 'src/c.ts:120–121');
  assert.deepEqual(await read2.locator('.code-row').evaluateAll((r: any[]) => r.map(x => x.textContent)), ['120line a', '121line b'], 'Read numbers lines from the offset');
  await read2.locator('.tool-notes').getByText('Showing lines 120-121 of 300. Use offset=122 to continue.', { exact: true }).waitFor();
  assert.ok(!(await read2.textContent()).includes('<harness>'));
  const proc = await open('proc-1');
  assert.equal((await proc.locator('.tool-exit').textContent()).trim(), 'exit 1');
  assert.equal(await proc.locator('pre.terminal').textContent(), 'built\nerror');
  assert.equal(await proc.locator('pre.terminal .ansi-red').textContent(), 'error');
  const todoCall = await open('todo-1');
  assert.deepEqual(await todoCall.locator('.tool-tasks li').evaluateAll((r: any[]) => r.map(x => [x.dataset.status, x.textContent.trim()])),
    [['completed', '#1Plan'], ['in_progress', '#2Building'], ['pending', '#4Ship']], 'Deleted tasks are hidden; the active task shows its active form');
  const search = await open('search-1');
  assert.equal(await search.locator('.tool-hits li').count(), 1, 'Only http(s) results become links');
  assert.equal(await search.locator('.tool-hits a').getAttribute('href'), 'https://www.example.com/docs');
  assert.equal(await search.locator('.tool-hits a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal((await search.locator('.tool-host').textContent()).trim(), 'example.com');
  const extract = await open('extract-1');
  assert.equal(await extract.locator('.tool-link').getAttribute('href'), 'https://example.com/a');
  await extract.locator('.tool-prose').getByText('Page body text.', { exact: true }).waitFor();
  const ask = await open('ask-1');
  assert.equal((await ask.locator('.tool-summary').textContent()).trim(), 'Which scope?');
  assert.equal(await ask.locator('.tool-answers dd').textContent(), 'All tools');
  const skill = await open('skill-1');
  assert.equal(await skill.locator('.tool-md strong').textContent(), 'this', 'Skill text renders as markdown');
  const boardCall = await open('board-1');
  assert.equal((await boardCall.locator('.tool-summary').textContent()).trim(), 'update #49 done');
  assert.equal(await boardCall.locator('.tool-section pre').textContent(), 'Updated #49 [done|medium]');
  assert.equal(await boardCall.locator('.tool-section-label', { hasText: 'Arguments' }).count(), 0);
  assert.equal((await page.locator('.tool[data-call="click-1"] .tool-summary').textContent()).trim(), 'ref e12');
  const mcp = await open('mcp-1');
  assert.equal(await mcp.getAttribute('data-tool'), null, 'Unknown tools keep the generic card');
  await mcp.locator('.tool-section-label', { hasText: 'Arguments' }).waitFor();
  await mcp.locator('.tool-section-label', { hasText: 'Output' }).waitFor();
  const failedEdit = page.locator('.tool[data-call="edit-2"]');
  await failedEdit.getByText('Could not find the exact text in src/b.ts.', { exact: true }).waitFor();
  assert.equal(await failedEdit.locator('.tool-counts').count(), 0, 'An edit that was not applied shows no change counts');
  await failedEdit.locator('summary').first().click();
  await failedEdit.getByText('Requested change (not applied, no line numbers)', { exact: true }).waitFor();
  assert.deepEqual(await failedEdit.locator('.diff-row').evaluateAll((rows: any[]) => rows.map(r => [r.dataset.kind, r.querySelector('.diff-line').textContent])), [['del', ''], ['add', '']]);
  const shell = page.locator('.tool[data-call="bash-1"]');
  assert.equal((await shell.locator('.tool-summary').textContent()).trim(), '$ pnpm test');
  assert.equal((await shell.locator('.tool-exit').textContent()).trim(), 'exit 2');
  const shellError = shell.locator('.tool-error');
  await shellError.getByText('Exited with code 2', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await shellError.locator('pre').textContent(), 'FAIL 2 tests', 'ANSI codes and the harness block are not shown as text');
  assert.equal(await shellError.locator('.ansi-red').textContent(), 'FAIL');
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
  const activity = page.locator('#extras .activity');
  assert.equal(await page.locator('#extras .activity').count(), 1, 'Tasks, processes and subagents share one disclosure');
  assert.equal(await activity.getAttribute('open'), null);
  assert.ok((await activity.boundingBox()).height < 60, 'Collapsed activity uses one row');
  assert.match(await activity.locator('.activity-counts').textContent(), /Tasks 1\/30.*1 process.*1 agent/);
  tasks[1]!.activeForm = 'Checking files';
  emit('42', 'submission', { record: { status: 'done' } });
  await activity.locator('summary').filter({ hasText: 'Checking files' }).waitFor();
  assert.equal(await activity.getAttribute('open'), null, 'Polling cannot open activity');
  await activity.locator('summary').click();
  tasks[1]!.activeForm = 'Checking more files'; emit('42', 'submission', { record: { status: 'done' } });
  await activity.locator('summary').filter({ hasText: 'Checking more files' }).waitFor();
  assert.notEqual(await activity.getAttribute('open'), null, 'Polling preserves user expansion');
  assert.ok((await activity.locator('.activity-body').boundingBox()).height <= 330);
  assert.deepEqual(await activity.locator('[data-process]').evaluateAll((r: any[]) => r.map(x => [x.dataset.status, x.querySelector('code').textContent])),
    [['running', 'pnpm run build --watch'], ['failed', 'pnpm test']]);
  assert.match(await activity.locator('[data-process="p-live"] small').textContent(), /^running · 1m \d+s$/);
  assert.equal(await activity.locator('[data-process="p-fail"] small').textContent(), 'failed · exit 2 · 4s');
  assert.equal(await activity.locator('[data-process="p-fail"]').getByRole('button', { name: 'Stop process' }).count(), 0, 'Finished processes have no stop control');
  await activity.locator('[data-process="p-live"] .activity-main').click();
  await activity.locator('[data-process="p-live"] .activity-output pre').filter({ hasText: 'compiled 12 modules' }).waitFor();
  assert.equal(await activity.locator('.activity-output b').count(), 0, 'Process output renders as text');
  await activity.locator('[data-process="p-live"]').getByRole('button', { name: 'Stop process' }).click();
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(processStops, ['42:p-live']);
  assert.deepEqual(await activity.locator('[data-child]').evaluateAll((r: any[]) => r.map(x => [x.dataset.child, x.querySelector('small').textContent])),
    [['90', '#90 · running'], ['91', '#91 · done']]);
  assert.equal(await activity.locator('[data-child="91"]').getByRole('button', { name: 'Stop subagent' }).count(), 0);
  await activity.locator('[data-child="90"]').getByRole('button', { name: 'Stop subagent' }).click();
  await new Promise(r => setTimeout(r, 100)); assert.ok(aborts.includes('90'), 'Stop subagent aborts the child conversation');
  await page.screenshot({ path: '/tmp/luna-activity-desktop.png' });
  await activity.locator('summary').click();
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
  await page.locator('.tool[data-call="live-1"] > details > summary').click();
  await page.evaluate(() => { (globalThis as any).savedTool = (globalThis as any).document.querySelector('.tool[data-call="live-1"]'); });
  emit('42', 'tool_execution_update', { toolCallId: 'live-1', output: { append: ' more output' } });
  await page.locator('.tool[data-call="live-1"] pre').filter({ hasText: 'more output' }).waitFor();
  assert.equal(await page.evaluate(() => (globalThis as any).savedTool === (globalThis as any).document.querySelector('.tool[data-call="live-1"]')), true);
  assert.notEqual(await page.locator('.tool[data-call="live-1"] > details').getAttribute('open'), null);
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
  await page.locator('#extras .activity summary').click();
  await page.locator('#extras .activity [data-child="90"]').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#extras .activity').evaluate((el: any) => el.scrollWidth <= el.clientWidth + 1), true, 'Open activity fits 320px');
  await page.screenshot({ path: '/tmp/luna-activity-mobile.png' });
  await page.locator('#extras .activity summary').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#new-session').click();
  await page.waitForFunction(() => localStorage.getItem('luna.session') === '44');
  assert.deepEqual(creations[0], { project: 7 }, 'Header + uses active project, not saved project');
  await page.evaluate(() => (globalThis as any).openSession('43'));
  await page.locator('#extras .activity').waitFor(); assert.equal(await page.locator('#extras .activity').getAttribute('open'), null, 'Session switch resets activity');
  assert.equal(await page.locator('#extras [data-process], #extras [data-child]').count(), 0, 'Activity rows belong to their own session');
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
  await page.evaluate(() => (globalThis as any).openSession('42'));
  await page.locator('#extras .activity summary').click();
  await page.locator('[data-child="90"]').getByRole('button', { name: 'Open subagent conversation' }).click();
  await page.waitForFunction(() => localStorage.getItem('luna.session') === '90');
  assert.deepEqual(errors, []);
  console.log('CHAT_VIEW_UI_OK: controls, project scope, reasoning, tools/errors, reports, copy/time, tasks/processes/subagents, activity, usage, mobile');
} finally {
  await browser?.close();
  for (const set of clients.values()) for (const client of set) { try { client.close(); } catch {} }
  (server as any).closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
