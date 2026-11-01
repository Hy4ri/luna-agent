// Copy source script jobs into Luna's native store without activating them or changing the source.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { CronStore } from './scheduler.js';
const data='/.luna';
const sourcePath=process.env.MIGRATION_SOURCE;
assert.ok(sourcePath,'MIGRATION_SOURCE must name the source jobs JSON file');
const source=JSON.parse(readFileSync(sourcePath,'utf8')).jobs;
const copied=JSON.parse(readFileSync(data+'/migration/cron-source.json','utf8'));
const python=process.env.MIGRATION_PYTHON!;
assert.ok(python,'MIGRATION_PYTHON is required');
const store=new CronStore(data+'/cron.db');
const receipts:any[]=[];
try {
 for(const job of source){
  assert.equal(job.no_agent,true,'Only script jobs can be copied by this importer');
  const meta=copied.find((j:any)=>j.id===job.id);
  assert.ok(meta,'Missing runner metadata for '+job.name);
  for(const field of ['name','script','deliver','workdir']) assert.deepEqual(meta[field],job[field],`Metadata changed: ${job.name}/${field}`);
  assert.deepEqual(meta.schedule,job.schedule,'Schedule changed: '+job.name);
  assert.ok(existsSync(data+'/scripts/'+job.script),'Missing script '+job.script);
  execFileSync(python,[data+'/bin/run-cron.py',job.id,'--check'],{stdio:'pipe'});
 }
 store.db.exec('BEGIN IMMEDIATE');
 try{
  for(const job of source){
   const interval=job.schedule.kind==='interval'?job.schedule.minutes*60_000:null;
   const expr=job.schedule.kind==='cron'?job.schedule.expr:'* * * * *';
   assert.ok(['cron','interval'].includes(job.schedule.kind));
   const execution={command:[python,data+'/bin/run-cron.py',job.id],cwd:job.workdir||data};
   const old=store.listJobs().find(j=>j.name===job.name);
   if(old){
    assert.equal(old.enabled,false,'Refusing to change active job '+job.name);
    assert.deepEqual(old.execution,execution,'Refusing to overwrite different job '+job.name);
    receipts.push({sourceId:job.id,id:old.id,name:job.name,sourceEnabled:job.enabled,enabled:false});continue;
   }
   const added=store.addJob(job.name,expr,job.prompt||'');
   store.db.prepare('UPDATE jobs SET enabled=0,next_run=NULL,execution=?,interval_ms=? WHERE id=?').run(JSON.stringify(execution),interval,added.id);
   receipts.push({sourceId:job.id,id:added.id,name:job.name,sourceEnabled:job.enabled,enabled:false});
  }
  store.db.exec('COMMIT');
 }catch(e){store.db.exec('ROLLBACK');throw e;}
 for(const r of receipts){
  const j=store.getJob(r.id)!;assert.equal(j.name,r.name);assert.equal(j.enabled,false);assert.equal(j.nextRun,null);assert.ok(j.execution);
 }
 writeFileSync(data+'/migration/cron-copy-receipt.json',JSON.stringify({createdAt:new Date().toISOString(),jobs:receipts},null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({copied:receipts.length,paused:receipts.length,scriptChecks:'passed',jobs:receipts},null,2));
}finally{store.close();}
process.exit(0);
