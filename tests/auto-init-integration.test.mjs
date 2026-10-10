import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ai,fromHost} from './runtime.mjs';
const core=await fromHost('dist/index.js');
const {loadExtensions}=await fromHost('dist/core/extensions/loader.js');
const paths=['../extensions/index.ts','../extensions/no-summary-guard.ts'].map(p=>fileURLToPath(new URL(p,import.meta.url)));
const wait=async predicate=>{for(let n=0;n<500;n++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Expected auto initialization boundary did not finish');};
async function fixture(settings,run,{mode='tui',confirm=()=>true,reloadFailure=false,modelOverride={}}={}){
 const root=await mkdtemp(join(tmpdir(),'acm auto TUI ')),old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=root;
 let session;try{
  await writeFile(join(root,'settings.json'),JSON.stringify(settings));
  let extensions=await loadExtensions(paths,root);assert.deepEqual(extensions.errors,[]);
  const modelRuntime=await core.ModelRuntime.create({credentials:new ai.InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  modelRuntime.hasConfiguredAuth=()=>true;modelRuntime.checkAuth=async()=>true;modelRuntime.getAuth=async()=>({auth:{apiKey:'fixture-only-no-network'},source:'FIXTURE'});
  const model={...modelRuntime.getModel('openai-codex','gpt-6.1-sol'),contextWindow:272000,...modelOverride};
  const settingsManager=core.SettingsManager.create(root,root);
  const loader={getExtensions:()=>extensions,getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=> 'Fixture only; no actual network',getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{extensions=await loadExtensions(paths,root);}};
  ({session}=await core.createAgentSession({cwd:root,agentDir:root,modelRuntime,model,thinkingLevel:'off',settingsManager,sessionManager:core.SessionManager.inMemory(root),resourceLoader:loader,tools:[]}));
  const notices=[],errors=[];let reloads=0,requests=0,dialogs=0;
  modelRuntime.streamSimple=()=>{throw new Error('Forbidden model/summary call');};
  session.agent.streamFunction=(m,_context,options)=>{
   const stream=ai.createAssistantMessageEventStream();
   if(options?.signal?.aborted){queueMicrotask(()=>{stream.push({type:'error',reason:'aborted',error:{role:'assistant',api:m.api,provider:m.provider,model:m.id,timestamp:Date.now(),content:[],stopReason:'aborted',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});stream.end();});return stream;}
   requests++;queueMicrotask(()=>{const usage={input:1000,output:8,cacheRead:0,cacheWrite:0,totalTokens:1008,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};const message={role:'assistant',api:m.api,provider:m.provider,model:m.id,timestamp:Date.now(),content:[{type:'text',text:'Fixture greeting'}],stopReason:'stop',usage};stream.push({type:'done',reason:'stop',message});stream.end();});return stream;
  };
  const f={root,session,settingsManager,model,get notices(){return notices;},get errors(){return errors;},get reloads(){return reloads;},get requests(){return requests;},get dialogs(){return dialogs;},get extensions(){return extensions;}};
  await session.bindExtensions({mode,onError:e=>errors.push(e),uiContext:{setStatus:()=>{},notify:text=>notices.push(text),confirm:async()=>{dialogs++;return confirm();}},commandContextActions:{waitForIdle:async()=>{},reload:async()=>{if(reloadFailure){reloads++;throw new Error('Injected reload failure');}await session.reload();reloads++;}}});
  await run(f);
 }finally{session?.dispose();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(root,{recursive:true,force:true});}
}
test('fresh TUI startup automatically dispatches setup/reloads, first greeting succeeds, no model call during init',()=>fixture({},async f=>{
 await wait(()=>f.settingsManager.getSettings().acm?.triggerPercent===70&&f.reloads===1);await new Promise(r=>setTimeout(r,30));
 assert.equal(f.requests,0);assert.equal(f.dialogs,0);assert.equal(f.session.sessionManager.getBranch().filter(e=>e.type==='message').length,0,'Auto command must not become a model prompt/transcript message');
 assert.equal(f.notices.filter(n=>n.includes('已初始化')).length,1);
 const cfg=f.settingsManager.getCompactionSettings(f.model);assert.equal(cfg.reserveTokens,81600);assert.equal(cfg.keepRecentTokens,149600);
 await f.session.prompt('早安');assert.equal(f.requests,1);assert.deepEqual(f.errors,[]);
}));
test('reported openai/luna272k fresh profile can greet after automatic setup without manual config',()=>fixture({},async f=>{
 await wait(()=>f.reloads===1&&f.settingsManager.getSettings().compaction?.modelOverrides?.['openai/gpt-6-luna']);assert.deepEqual(f.settingsManager.getSettings().compaction.modelOverrides['openai/gpt-6-luna'],{reserveTokens:81600,keepRecentTokens:149600});assert.equal(f.requests,0);await f.session.prompt('早安');assert.equal(f.requests,1);assert.deepEqual(f.errors,[]);
},{modelOverride:{provider:'openai',id:'gpt-6-luna',api:'openai-responses'}}));

test('custom ratios survive automatic setup; selecting a new model initializes it and preserves prior budget',()=>fixture({acm:{triggerPercent:80,targetPercent:60},theme:'fixture'},async f=>{
 await wait(()=>f.reloads===1&&f.settingsManager.getSettings().compaction?.modelOverrides?.['openai-codex/gpt-6.1-sol']);
 const before=f.settingsManager.getSettings().compaction.modelOverrides['openai-codex/gpt-6.1-sol'];
 await f.session.setModel({...f.model,id:'fixture-second-model',contextWindow:512000});
 await wait(()=>f.reloads===2&&f.settingsManager.getSettings().compaction?.modelOverrides?.['openai-codex/fixture-second-model']);
 const s=f.settingsManager.getSettings();assert.equal(s.acm.triggerPercent,80);assert.equal(s.acm.targetPercent,60);assert.equal(s.theme,'fixture');assert.deepEqual(s.compaction.modelOverrides['openai-codex/gpt-6.1-sol'],before);assert.equal(s.compaction.modelOverrides['openai-codex/fixture-second-model'].reserveTokens,102400);assert.equal(f.requests,0);assert.deepEqual(f.errors,[]);
}));
test('conflict decline keeps bytes and emits no request; explicit setup can later confirm and enable',async()=>{
 let accept=false;await fixture({compaction:{enabled:false}},async f=>{
  await wait(()=>f.dialogs===1);await new Promise(r=>setTimeout(r,30));const before=await readFile(join(f.root,'settings.json'),'utf8');assert.equal(f.reloads,0);assert.equal(f.requests,0);
  await f.session.prompt('blocked greeting');assert.equal(f.requests,0);assert.deepEqual(f.errors,[],'Expected setup mismatch should not dump producer/guard stacks');assert.equal(await readFile(join(f.root,'settings.json'),'utf8'),before);assert.equal(f.dialogs,1,'No same-state repeat prompt');
  accept=true;await f.session.prompt('/acm-setup');assert.equal(f.reloads,1);assert.equal(f.dialogs,2);assert.equal(f.settingsManager.getCompactionSettings(f.model).enabled,true);assert.equal(f.requests,0);
 },{confirm:()=>accept});
});
test('busy model selection defers disk mutation until the stream settles',()=>fixture({},async f=>{
 await wait(()=>f.reloads===1&&f.settingsManager.getSettings().acm?.triggerPercent===70);
 let release;f.session.agent.streamFunction=(m)=>{const stream=ai.createAssistantMessageEventStream();release=()=>{const message={role:'assistant',api:m.api,provider:m.provider,model:m.id,timestamp:Date.now(),content:[{type:'text',text:'held fixture'}],stopReason:'stop',usage:{input:1000,output:8,cacheRead:0,cacheWrite:0,totalTokens:1008,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};stream.push({type:'done',reason:'stop',message});stream.end();};return stream;};
 const running=f.session.prompt('Held fixture stream');await wait(()=>typeof release==='function'&&f.session.isStreaming);
 const before=await readFile(join(f.root,'settings.json'),'utf8');
 await f.session.setModel({...f.model,id:'busy-next-model',contextWindow:512000});await new Promise(r=>setTimeout(r,30));assert.equal(await readFile(join(f.root,'settings.json'),'utf8'),before);assert.equal(f.reloads,1);
 release();await running;await wait(()=>f.reloads===2&&f.settingsManager.getSettings().compaction?.modelOverrides?.['openai-codex/busy-next-model']);assert.deepEqual(f.errors,[]);
}));
test('pending user queue prevents setup mutation until cleared and a fresh model boundary',()=>fixture({},async f=>{
 await wait(()=>f.reloads===1&&f.settingsManager.getSettings().acm?.triggerPercent===70);
 await f.session.steer('Queued fixture; never send');const before=await readFile(join(f.root,'settings.json'),'utf8');const next={...f.model,id:'queue-next-model',contextWindow:512000};await f.session.setModel(next);await new Promise(r=>setTimeout(r,40));assert.equal(await readFile(join(f.root,'settings.json'),'utf8'),before);assert.equal(f.reloads,1);assert.equal(f.requests,0);
 f.session.clearQueue();await f.session.setModel({...next,id:'queue-cleared-model'});await wait(()=>f.reloads===2&&f.settingsManager.getSettings().compaction?.modelOverrides?.['openai-codex/queue-cleared-model']);assert.equal(f.requests,0);
}));
test('SDK mode never automatically mutates settings or queues model commands',()=>fixture({},async f=>{
 await new Promise(r=>setTimeout(r,40));assert.equal(await readFile(join(f.root,'settings.json'),'utf8'),'{}');assert.equal(f.reloads,0);assert.equal(f.requests,0);assert.equal(f.dialogs,0);
},{mode:'sdk'}));
test('auto initialization reload failure restores original bytes and cannot send a model request',()=>fixture({},async f=>{
 await wait(()=>f.reloads===1);await wait(()=>f.errors.length===1);assert.equal(await readFile(join(f.root,'settings.json'),'utf8'),'{}');assert.equal(f.requests,0);
},{reloadFailure:true}));
