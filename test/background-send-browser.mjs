// Optional real-browser acceptance (no new framework or credentials). Build web first.
// Run: node --import tsx test/background-send-browser.mjs
// Use existing Playwright/Chromium via LUNA_PLAYWRIGHT_PATH and LUNA_CHROMIUM_PATH if needed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { serve } from '@hono/node-server';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.LUNA_PLAYWRIGHT_PATH || 'playwright');
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { openLuna, context } from '../src/luna.ts';
import { ConversationStore } from '../src/conversations.ts';
import { createApp } from '../src/server.ts';
import { SettingsStore } from '../src/settings.ts';
import { UploadStore } from '../src/uploads.ts';
import { conversationStorage } from '../src/conversation-storage.ts';
import { WorkerStore, WorkerHub, ExecTarget } from '../src/workers.ts';

const dir = mkdtempSync(join(tmpdir(), 'luna-448-ui-'));
const worktreeCwd = join(dir, 'actual-worktree'); mkdirSync(worktreeCwd);
const faux = fauxProvider({ models: [{ id:'fixture-model', reasoning:true, input:['text','image'] }] });
let releaseSource;
faux.setResponses(Array.from({length:100}, () => async transcript => {
  if (JSON.stringify(transcript.messages).includes('source-hold')) return await new Promise(resolve => { releaseSource = () => resolve(fauxAssistantMessage('source finished')); });
  return fauxAssistantMessage('offline fixture ack');
}));
const models = createModels(); models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId:faux.getModel().id };
const workerStore=new WorkerStore(join(dir,'workers.db'));
const workers=new WorkerHub(workerStore);
const fixtureToken='offline-fixture-only-token';
let harness, server, browser;
const facts = [];
try {
  harness = await openLuna({ dbPath:join(dir,'luna.db'), models, memory:false, coding:false, cwd:dir, remoteEnv:(worker,cwd)=>workers.env(worker,cwd) });
  const conversations = new ConversationStore(harness);
  const project = conversations.projects.create('Fixture project',dir);
  const settings = new SettingsStore(join(dir,'config.json'),dir);
  const uploads = new UploadStore(join(dir,'uploads')); uploads.bind(conversationStorage(harness).db);
  const app = createApp({ harness, conversations, models, settings, uploads, workers, token:fixtureToken, cwd:dir, agent:{model,thinkingLevel:'off',instructions:'DEFAULT_ONLY'} });
  server = serve({ fetch:app.fetch, hostname:'127.0.0.1',port:0 });
  await once(server,'listening'); const base = `http://127.0.0.1:${server.address().port}`;
  const browserBase=`http://luna.test:${server.address().port}`;
  async function request(path,body,method='POST') {
    const response = await fetch(base+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+fixtureToken},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`); return response.json();
  }
  const source = await request('/v1/sessions',{model,thinkingLevel:'high',project:project.id,cwd:worktreeCwd,instructions:'SOURCE_ONLY'});
  await request(`/v1/sessions/${source.id}/messages?async=1`,{requestId:'hold-source',content:'source-hold'});
  for(let n=0;n<100&&!releaseSource;n++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(typeof releaseSource,'function','source must be running before background send');
  browser = await chromium.launch({executablePath:process.env.LUNA_CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined),headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--no-proxy-server','--host-resolver-rules=MAP luna.test 127.0.0.1']});
  const browserContext = await browser.newContext({viewport:{width:1280,height:900}, serviceWorkers:'block'});
  await browserContext.addInitScript(({source,fixtureToken}) => {
    localStorage.setItem('luna.token',fixtureToken);
    if (!localStorage.getItem('fixture-seeded')) { localStorage.setItem('fixture-seeded','yes'); localStorage.setItem('luna.session',String(source)); }
  },{source:source.id,fixtureToken});
  const page = await browserContext.newPage();
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  const writes=[]; page.on('request',r => { if(r.method()==='POST' && /\/v1\/sessions(?:$|\/\d+\/(?:messages|background-commands))/.test(new URL(r.url()).pathname)) writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()}); });
  await page.goto(browserBase,{waitUntil:'domcontentloaded'});
  await page.locator('#input').waitFor();
  await page.locator('#new-session:enabled').waitFor();
  const input = page.locator('#input');
  const initialUrl=page.url();
  await input.fill('background first');
  await input.press('Control+Enter');
  await page.waitForFunction(()=>document.querySelector('#input')?.value==='');
  assert.equal(await input.evaluate(element=>element===document.activeElement),true);
  await input.fill('new typing survives');
  await page.getByText('Sent to a new session',{exact:true}).waitFor();
  assert.equal(page.url(),initialUrl); assert.equal(await input.inputValue(),'new typing survives');
  assert.equal(await page.evaluate(()=>localStorage.getItem('luna.session')),String(source.id));
  let all = await request('/v1/sessions',undefined,'GET');
  assert.equal(all.sessions.length,2);
  const destination=all.sessions.find(row=>row.id!==source.id);
  const conv=await harness.conversation(destination.id,context); const agent=await conv.agent(context);
  assert.deepEqual(agent.model,model); assert.equal(agent.thinkingLevel,'high'); assert.equal(agent.cwd,worktreeCwd); assert.equal(agent.instructions,'DEFAULT_ONLY');
  assert.equal(conversations.projects.projectOf(destination.id),project.id);
  const record=await harness.commit(tx=>tx.conversation(destination.id),context); assert.equal(record.owner,undefined);
  facts.push('Existing running session: independent destination, exact model/high thinking/project/worktree, no source instructions/history, same view/focus, newer typing preserved.');
  releaseSource?.();
  // Keep the actual rendered UI for inspection, not a fabricated design.
  await page.screenshot({path:join(dir,'wide.png'),fullPage:true});

  // A held real IDB write transaction simulates slow persistence without mocking the implementation.
  await page.evaluate(async () => {
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('luna_background_send_outbox',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    window.releaseCaptureLock=false;
    const tx=db.transaction('records','readwrite'), store=tx.objectStore('records');
    const spin=()=>{const req=store.get('fixture-lock'); req.onsuccess=()=>{if(!window.releaseCaptureLock)spin()}}; spin();
    tx.oncomplete=()=>db.close();
  });
  await input.fill('captured-prefix'); await input.press('Control+Enter');
  await input.press('End'); await input.pressSequentially('new suffix');
  await page.evaluate(()=>{window.releaseCaptureLock=true});
  await page.waitForFunction(()=>document.querySelector('#input')?.value==='new suffix');
  assert.equal(await input.inputValue(),'new suffix','only uncaptured typing must remain after durable commit');
  facts.push('Typing while IndexedDB commit is blocked retains only the new text.');
  async function eventually(fn,label) {
    for(let n=0;n<100;n++) { const value=await fn(); if(value)return value; await new Promise(resolve=>setTimeout(resolve,50)); }
    throw new Error('Timed out: '+label);
  }
  async function records(target=page) { return target.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('luna_background_send_outbox',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    try { return await new Promise((resolve,reject)=>{const r=db.transaction('records','readonly').objectStore('records').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)}); }
    finally {db.close()}
  }); }
  async function accepted(id,target=page) { return eventually(async()=> (await records(target)).find(r=>r.id===id&&r.state==='accepted'), 'accepted '+id); }
  async function send(text,shortcut='Control+Enter') {
    const before=new Set((await records()).map(r=>r.id)); await input.fill(text); await input.press(shortcut);
    return eventually(async()=> (await records()).find(r=>!before.has(r.id)),'captured '+text);
  }
  async function reload() { await page.reload({waitUntil:'domcontentloaded'}); await page.locator('#new-session:enabled').waitFor(); }
  assert.equal(await page.evaluate(()=>isSecureContext),false);
  assert.equal(await page.evaluate(()=>typeof crypto.subtle),'undefined');
  const expectedScope=browserBase+'|'+createHash('sha256').update(fixtureToken).digest('hex');
  assert.ok((await records()).every(r=>r.scope===expectedScope));
  assert.ok((await records()).every(r=>!JSON.stringify(r).includes(fixtureToken)));
  facts.push('Insecure HTTP: real browser SHA-256 fallback matches Node crypto; no bearer token is persisted in recovery.');
  const prefixRecord=(await records()).sort((a,b)=>a.createdAt-b.createdAt).at(-1); await accepted(prefixRecord.id);

  // Creation committed, but its HTTP response was lost. Recovery must GET only.
  let loseCreation=true;
  await page.route('**/v1/sessions',async route=>{
    if(route.request().method()==='POST'&&loseCreation) {loseCreation=false;await route.fetch({url:route.request().url().replace(browserBase,base)});await route.abort('failed');} else await route.continue();
  });
  const creationLost=await send('lost creation response');
  await eventually(async()=> (await records()).find(r=>r.id===creationLost.id&&r.state==='failed'),'creation failure persisted');
  const creationWriteCount=writes.filter(r=>r.path==='/v1/sessions').length;
  const totalWrites=writes.length;
  await reload();
  await page.getByRole('button',{name:'Retry',exact:true}).waitFor();
  assert.equal(writes.length,totalWrites,'reload cannot automatically create/send');
  await input.fill('new draft after reload');
  await page.getByRole('button',{name:'Retry',exact:true}).click();
  await accepted(creationLost.id);
  assert.equal(writes.filter(r=>r.path==='/v1/sessions').length,creationWriteCount,'lost creation response reuses original session');
  assert.equal(await input.inputValue(),'new draft after reload');
  await page.unroute('**/v1/sessions');
  facts.push('Lost creation response: reload is GET-only; explicit Retry recovers the same session and preserves the new draft.');

  // Admission committed, but the HTTP acknowledgement was lost. Reload recognizes the receipt.
  let loseMessage=true;
  await page.route('**/v1/sessions/*/messages?async=1',async route=>{
    if(loseMessage){loseMessage=false;await route.fetch({url:route.request().url().replace(browserBase,base)});await route.abort('failed')}else await route.continue();
  });
  const messageLost=await send('lost message response');
  await eventually(async()=> (await records()).find(r=>r.id===messageLost.id&&r.state==='failed'),'message failure persisted');
  const afterMessage=writes.length;
  await reload(); await accepted(messageLost.id);
  assert.equal(writes.length,afterMessage,'receipt reconciliation must not replay an accepted message');
  await page.unroute('**/v1/sessions/*/messages?async=1');
  facts.push('Lost message response: reload recognizes durable acceptance without another POST.');

  // A definitive rejection retains the complete payload, while newer typing remains editable.
  let rejectOnce=true;
  await page.route('**/v1/sessions/*/messages?async=1',async route=>{
    if(rejectOnce){rejectOnce=false;await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'fixture rejection'})})}else await route.continue();
  });
  const rejected=await send('rejected payload retained');
  const failed=await eventually(async()=> (await records()).find(r=>r.id===rejected.id&&r.state==='failed'),'rejection persisted');
  assert.equal(failed.payload.text,'rejected payload retained');
  await input.fill('newer draft after rejection');
  await page.unroute('**/v1/sessions/*/messages?async=1');
  const beforeRetryCreation=writes.filter(r=>r.path==='/v1/sessions').length;
  await page.getByRole('button',{name:'Retry',exact:true}).click(); await accepted(rejected.id);
  assert.equal(writes.filter(r=>r.path==='/v1/sessions').length,beforeRetryCreation);
  assert.equal(await input.inputValue(),'newer draft after rejection');
  facts.push('Rejected message: retained payload retries into the same destination without restoring over newer typing.');

  // Client-only commands are rejected before persistence or any network writes, even with suggestions open.
  for(const command of ['/model','/models','/compact','/compress']) {
    const before=writes.length, previous=(await records()).length;
    await input.fill(command); await input.press('Control+Enter');
    assert.equal(await input.inputValue(),command); assert.equal(writes.length,before); assert.equal((await records()).length,previous);
  }
  facts.push('All four local-only commands retain the draft and make no creation/delivery writes.');

  // Modifier/IME/repeat guards do not capture; plain Enter retains foreground behavior.
  for(const event of [{ctrlKey:true,isComposing:true},{ctrlKey:true,repeat:true},{ctrlKey:true,altKey:true},{ctrlKey:true,shiftKey:true}]) {
    const before=writes.length; await input.fill('guarded draft');
    await input.evaluate((element,flags)=>element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...flags})),event);
    assert.equal(await input.inputValue(),'guarded draft'); assert.equal(writes.length,before);
  }
  const foregroundCount=writes.filter(r=>r.path===`/v1/sessions/${source.id}/messages`).length;
  await input.fill('ordinary foreground'); await input.press('Enter');
  await eventually(()=>writes.filter(r=>r.path===`/v1/sessions/${source.id}/messages`).length===foregroundCount+1,'normal Enter');
  facts.push('IME/repeat/Alt/Shift guards do not capture; ordinary Enter still sends to the visible session.');

  // Abort the real capture transaction to exercise storage failure. No fake in-memory outbox.
  await page.evaluate(()=>{
    const native=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){
      const request=native.apply(this,args);
      if(this.transaction.db.name==='luna_background_send_outbox'&&args[0]?.state==='persisted') {
        IDBObjectStore.prototype.put=native;
        queueMicrotask(()=>this.transaction.abort());
      }
      return request;
    };
  });
  const storageWrites=writes.length;
  await input.fill('storage failure must preserve this'); await input.press('Control+Enter');
  await page.getByText('Browser storage failed.',{exact:true}).last().waitFor({timeout:3000});
  assert.equal(await input.inputValue(),'storage failure must preserve this'); assert.equal(writes.length,storageWrites);
  facts.push('A real IndexedDB transaction abort preserves the draft and makes no server writes.');

  // Fresh composer + selected thinking + Cmd shortcut, with no source session opened.
  await page.locator('#new-session').click();
  await page.getByRole('button',{name:'Reasoning level: Off',exact:true}).click();
  await page.getByRole('radio',{name:'Max',exact:true}).click(); await input.click();
  const freshBefore=writes.length;
  const fresh=await send('fresh Cmd background','Meta+Enter'); await accepted(fresh.id);
  const freshWrite=writes.slice(freshBefore).find(r=>r.path==='/v1/sessions'); assert.equal(freshWrite.body.thinkingLevel,'max'); assert.equal(freshWrite.body.cwd,dir); assert.equal(freshWrite.body.project,project.id);
  assert.equal(await page.evaluate(()=>localStorage.getItem('luna.session')),null);
  facts.push('Fresh composer: Cmd+Enter captures selected Max thinking and resolved project cwd without opening the new session.');

  // Attachment-only payload follows the existing file pipeline and durable content format.
  await page.locator('#file').setInputFiles({name:'fixture-note.txt',mimeType:'text/plain',buffer:Buffer.from('offline attachment contents')});
  await eventually(()=>page.locator('#input').getAttribute('placeholder').then(p=>p!=='Uploading…'),'attachment upload');
  await page.getByRole('button',{name:'Remove attachment fixture-note.txt',exact:true}).waitFor();
  const fileSend=await send(''); await accepted(fileSend.id);
  const fileWrite=writes.find(r=>r.body.requestId===fileSend.messageRequestId);
  assert.equal(fileWrite.body.content[0].type,'file');
  assert.match(fileWrite.body.content[0].uploadId,/^[a-f0-9]{64}$/); assert.equal(fileWrite.body.content[0].attachment.name,'fixture-note.txt');
  assert.equal(await page.getByRole('button',{name:'Remove attachment fixture-note.txt',exact:true}).count(),0);
  facts.push('Attachment-only send preserves uploaded-file content through the normal message pipeline.');

  // Server commands are real one-shot command requests, not model prompts.
  await (await harness.conversation(Number((await accepted(fileSend.id)).sessionId),context)).abort(context);
  const beforeCommands=faux.state.callCount;
  const command=await send('/stop'); const commandAccepted=await accepted(command.id);
  assert.equal(commandAccepted.notice,'Stopped.'); assert.equal(faux.state.callCount,beforeCommands);
  facts.push('Server /stop is delivered through the command endpoint, produces a notice, and makes no model call.');

  // Same IDB scope across tabs: no duplicate Retry claim or duplicate delivery.
  let holdFailure=true;
  await page.route('**/v1/sessions/*/messages?async=1',async route=>{
    if(holdFailure){holdFailure=false;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture offline"}'})}else await route.continue();
  });
  const shared=await send('cross-tab retry'); await eventually(async()=> (await records()).find(r=>r.id===shared.id&&r.state==='failed'),'shared failure');
  await page.unroute('**/v1/sessions/*/messages?async=1');
  const tab=await browserContext.newPage();
  tab.on('request',r=>{if(r.method()==='POST'&&/\/v1\/sessions(?:$|\/\d+\/(?:messages|background-commands))/.test(new URL(r.url()).pathname))writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()})});
  await tab.goto(browserBase,{waitUntil:'domcontentloaded'}); await tab.getByRole('button',{name:'Retry',exact:true}).waitFor();
  const sharedBefore=writes.filter(r=>r.body.requestId===shared.messageRequestId).length;
  await Promise.all([page.getByRole('button',{name:'Retry',exact:true}).click(),tab.getByRole('button',{name:'Retry',exact:true}).click()]);
  await accepted(shared.id);
  assert.equal(writes.filter(r=>r.body.requestId===shared.messageRequestId).length,sharedBefore+1);
  await tab.close();
  facts.push('Two tabs clicking Retry concurrently acquire one durable claim and issue exactly one message POST.');

  await page.setViewportSize({width:320,height:720});
  const mobile=await send('mobile background'); await accepted(mobile.id);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow at 320px');
  await page.screenshot({path:join(dir,'mobile.png'),fullPage:true});
  facts.push('320px viewport: shortcut works, status stays nonmodal, no horizontal overflow.');
  // A registered offline worker must keep its own target and explicit worktree, never inherit main cwd.
  const remoteWorker=workerStore.create('Fixture remote').worker;
  workerStore.seen(remoteWorker.id,{cwd:'/srv/fixture-default',platform:'linux'});
  conversations.projects.setWorkerDir(project.id,remoteWorker.id,'/srv/fixture-project');
  const remoteSource=await request('/v1/sessions',{model,thinkingLevel:'high',project:project.id,worker:remoteWorker.id,cwd:'/srv/fixture-worktree'});
  await page.evaluate(id=>{localStorage.setItem('luna.session',String(id));sessionStorage.setItem('luna.session',String(id))},remoteSource.id);
  await reload();
  const remoteSend=await send('offline worker target'); const remoteAccepted=await accepted(remoteSend.id);
  const remoteConv=await harness.conversation(Number(remoteAccepted.sessionId),context);
  assert.equal((await remoteConv.agent(context)).cwd,'/srv/fixture-worktree');
  assert.equal((await harness.snapshot(ExecTarget,Number(remoteAccepted.sessionId),context)).worker,remoteWorker.id);
  assert.equal(remoteAccepted.settings.worker,remoteWorker.id);
  facts.push('Registered offline worker: captured worker ID and explicit remote worktree survive background creation; no main-host fallback.');
  assert.deepEqual(errors,[],'no uncaught browser errors');
  console.log(JSON.stringify({facts,writes:writes.length,providerCalls:faux.state.callCount},null,2));
} finally {
  releaseSource?.();
  await browser?.close();
  if(server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
  await harness?.close(context);
  workers.close(); workerStore.close();
  rmSync(dir,{recursive:true,force:true});
}
