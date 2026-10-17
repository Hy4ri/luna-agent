import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SettingsStore } from "./settings.js";
import { loadConfig } from "./config.js";
import { startRuntime } from "./runtime.js";
import { createApp } from "./server.js";
import { context } from "./luna.js";
import { Children } from "./delegate.js";
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
const dir = mkdtempSync(join(process.cwd(), ".settings-"));
try {
 const path = join(dir, "config.json");
 writeFileSync(path, JSON.stringify({ dataDir: dir, provider: "anthropic", model: "old" }));
 writeFileSync(join(dir,"providers.json"), JSON.stringify({ custom: [{id:"local",name:"Local",api:"openai-completions",baseUrl:"http://localhost:9999/v1",models:[{id:"demo"}]}],defaultModel:{provider:"faux",modelId:"faux"} }));
 writeFileSync(join(dir,"mcp.json"),JSON.stringify({servers:[{name:"disabled",transport:"http",url:"http://localhost/mcp",enabled:false,headers:{Authorization:"secret"}}]}));
 const store = new SettingsStore(path, dir);
 assert.equal(store.read().provider,"faux");
 assert.equal(store.read().providers[0]?.id,"local");
 assert.equal(store.read().mcpServers.length,1);
 assert.equal(statSync(path).mode & 0o777,0o600);
 assert.ok(!JSON.stringify(store.view()).includes('"secret"'));
 let view = store.view(); store.replace(view.config,view.revision);
 assert.equal((store.read().mcpServers[0] as any).headers.Authorization,"secret");
 assert.throws(()=>store.replace(view.config, "stale"), /Reload/);
 const before = readFileSync(path,"utf8");
 view = store.view();
 assert.throws(()=>store.replace({...view.config,bogus:1},view.revision));
 assert.equal(readFileSync(path,"utf8"),before);
 store.update(s=>{s.provider="faux";s.model="new-default";s.mcpServers=[];});
 assert.equal(new SettingsStore(path,dir).read().model,"new-default");
 assert.equal(new SettingsStore(path,dir).read().mcpServers.length,0);
 console.log("OK: migration once, strict validation, atomic preservation, 0600, hidden secrets, revision conflicts");
 const faux=fauxProvider({models:[{id:"main"},{id:"child"}]}); const models=createModels(); models.setProvider(faux.provider);
 const m=faux.getModel();
 store.update(s=>{s.model=m.id;s.providers=[];});
 const rt=await startRuntime(loadConfig(path),{models,model:{provider:m.provider,modelId:m.id}});
 try {
  const app=createApp({harness:rt.harness,models:rt.models,providers:rt.providers,mcp:rt.mcp,settings:rt.settings,agent:{model:rt.model},token:"test"});
  assert.equal((await app.request("/v1/settings")).status,401);
  const headers={authorization:"Bearer test","content-type":"application/json"};
  let response=await app.request("/v1/settings",{headers}); let body=await response.json() as any;
  body.config.thinkingLevel="high"; body.config.instructions="Configured instructions";
  body.config.subagents={provider:m.provider,model:"child",thinkingLevel:"low",cwd:dir};
  response=await app.request("/v1/settings",{method:"PUT",headers,body:JSON.stringify(body)});
  assert.equal(response.status,200,await response.clone().text());
  assert.equal((await response.json() as any).restartRequired,false);
  assert.equal(rt.settings!.resolved().subagents.thinkingLevel,"low");
  const newSession = await (await app.request("/v1/sessions",{method:"POST",headers,body:"{}"})).json() as any;
  const session = await (await app.request(`/v1/sessions/${newSession.id}`,{headers})).json() as any;
  assert.equal(session.agent.thinkingLevel,"high"); assert.equal(session.agent.instructions,"Configured instructions");
  const invalid = await (await app.request("/v1/settings",{headers})).json() as any;
  invalid.config.subagents={provider:"missing",model:"missing"};
  assert.equal((await app.request("/v1/settings",{method:"PUT",headers,body:JSON.stringify(invalid)})).status,400);

  // Drive the real delegate tool through the runtime, for both blank and forked children.
  for (const fork of [false,true]) {
    faux.setResponses(Array(30).fill((ctx: any, options: any, state: any, model: any) => {
      if (model.id === "child") return fauxAssistantMessage([fauxText("child done")]);
      if (ctx.messages.some((m: any) => m.role === "toolResult")) return fauxAssistantMessage([fauxText("parent done")]);
      return fauxAssistantMessage([fauxToolCall("delegate_task",{action:"spawn",task:"test child defaults",fork})],{stopReason:"toolUse"});
    }));
    const parent=await rt.harness.createConversation({ownership:{kind:"ownerless"},agent:{model:{provider:m.provider,modelId:m.id},thinkingLevel:"high"}},context);
    await (await parent.submit({type:"input",content:"delegate"},context)).wait(context);
    const kids=await rt.harness.snapshot(Children,parent.id,context);
    assert.ok(kids);
    assert.equal(kids.children.length,1);
    const child=await rt.harness.conversation(kids.children[0]!.id as never,context);
    const agent=await child!.agent(context);
    assert.equal(agent.model?.modelId,"child"); assert.equal(agent.thinkingLevel,"low"); assert.equal(agent.cwd,dir);
    assert.ok(!agent.tools.some(t=>t.name==="delegate_task"));
  }
  console.log("OK: real delegate tool applies independent child model, thinking and cwd to spawn and fork");
  await rt.providers.setDefaultModel({provider:m.provider,modelId:m.id});
  assert.equal(JSON.parse(readFileSync(path,"utf8")).model,m.id);
  await rt.mcp.add({name:"off",transport:"http",url:"http://localhost/mcp",enabled:false});
  assert.equal(JSON.parse(readFileSync(path,"utf8")).mcpServers[0].name,"off");
  await rt.mcp.remove("off");
  body=await (await app.request("/v1/settings",{headers})).json();
  body.config.server.port=9123;
  response=await app.request("/v1/settings",{method:"PUT",headers,body:JSON.stringify(body)});
  assert.equal(response.status,200);
  assert.equal((await response.json() as any).restartRequired,true);
  assert.throws(()=>rt.providers.setDefaultModel({provider:m.provider,modelId:m.id}),/Restart/);
  console.log("OK: authenticated settings API, live defaults, shared provider/MCP writes, restart state");
 } finally {await rt.close();}
} finally {rmSync(dir,{recursive:true,force:true});}
console.log("SETTINGS_OK");
