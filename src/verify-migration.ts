import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CronStore, Scheduler } from './scheduler.js';
import { startRuntime } from './runtime.js';
import { parseConfig } from './config.js';
import { context } from './luna.js';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
const dir=mkdtempSync(join(process.cwd(),'.vmigrate-'));
try {
 const store=new CronStore(join(dir,'cron.db'));
 const slot=Date.now()+60000;
 const job=store.addJob('script','* * * * *','');
 store.db.prepare('UPDATE jobs SET execution=?, interval_ms=?, next_run=? WHERE id=?').run(JSON.stringify({command:[process.execPath,'-e','process.stdout.write("script worked")']}),300000,slot,job.id);
 const scheduler=new Scheduler({harness:{resume(){}} as any,store,defaultModel:{provider:'no-model',modelId:'none'}});
 await scheduler.start();await scheduler.tick(slot);await scheduler.idle();await scheduler.stop();
 assert.equal(store.runs(job.id)[0]?.output,'script worked');
 assert.equal(store.getJob(job.id)?.nextRun,slot+300000);
 assert.equal(store.runs(job.id)[0]?.status,'ok');store.close();
 console.log('OK scripts run without a model; interval retained; output logged');
 writeFileSync(join(dir,'SOUL.md'),'Migration identity marker: Luna stays Luna.');
 writeFileSync(join(dir,'USER.md'),'Migration user marker: m57.');
 writeFileSync(join(dir,'MEMORY.md'),'Migration memory marker: do not merge without permission.');
 let seen=''; const faux=fauxProvider();const models=createModels();models.setProvider(faux.provider);
 faux.setResponses([(ctx:any)=>{seen=JSON.stringify(ctx);return fauxAssistantMessage([fauxText('ok')]);}]);
 const m=faux.getModel();
 const rt=await startRuntime(parseConfig({dataDir:dir,extensions:['memory']},dir,{}),{models,model:{provider:m.provider,modelId:m.id},log:()=>{}});
 try {
  const conv=await rt.harness.createConversation({ownership:{kind:'ownerless'},agent:{model:rt.model}},context);
  const sub=await conv.submit({type:'input',content:'identity probe'},context);await sub.wait(context);
  const prompt=seen;
  assert.ok(prompt.includes('Migration identity marker'),prompt);
  assert.ok(prompt.includes('Migration user marker'),prompt);
  assert.ok(prompt.includes('Migration memory marker'),prompt);
  console.log('OK SOUL, USER, MEMORY included in actual conversation context');
 } finally {await rt.close();}
 console.log('MIGRATION_OK');
}finally{rmSync(dir,{recursive:true,force:true});}
process.exit(0);
