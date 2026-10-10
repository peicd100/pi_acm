import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectSetup,commitSetup,rollbackConfig} from '../src/config_v1.4.4.mjs';
const base=JSON.parse(readFileSync(new URL('../policy.json',import.meta.url)));
const model={provider:'fixture',id:'luna',contextWindow:272000};
function fixture(global,run){const root=mkdtempSync(join(tmpdir(),'acm auto init ')),path=join(root,'settings.json');writeFileSync(path,JSON.stringify(global));const options=()=>({path,cwd:root,projectTrusted:false,runtimeSettings:JSON.parse(readFileSync(path)),model,base});try{run({root,path,options});}finally{rmSync(root,{recursive:true,force:true});}}
test('fresh settings automatically initializes70/55 once, current model only, preserves unrelated settings',()=>fixture({theme:'fixture',compaction:{modelOverrides:{'other/model':{reserveTokens:1,keepRecentTokens:2}}}},({path,options})=>{
 const p=inspectSetup(options());assert.equal(p.kind,'automatic');assert.match(p.fingerprint,/^[a-f0-9]{64}$/);
 commitSetup(options(),{fingerprint:p.fingerprint});const saved=JSON.parse(readFileSync(path));
 assert.equal(saved.theme,'fixture');assert.equal(saved.acm.triggerPercent,70);assert.equal(saved.acm.targetPercent,55);
 assert.deepEqual(saved.compaction.modelOverrides['fixture/luna'],{reserveTokens:81600,keepRecentTokens:149600});
 assert.deepEqual(saved.compaction.modelOverrides['other/model'],{reserveTokens:1,keepRecentTokens:2});assert.equal(saved.compaction.reserveTokens,undefined);
 const bytes=readFileSync(path,'utf8'),ready=inspectSetup(options());assert.equal(ready.kind,'ready');assert.equal(commitSetup(options(),{fingerprint:ready.fingerprint}),null);assert.equal(readFileSync(path,'utf8'),bytes);
}));
test('upgrade treats existing explicit95/85 as a custom profile and leaves already-matching owned settings byte-identical',()=>fixture({acm:{triggerPercent:95,targetPercent:85,autoInit:{version:1,models:{'fixture/luna':{reserveTokens:13600,keepRecentTokens:231200}}}},compaction:{enabled:true,modelOverrides:{'fixture/luna':{reserveTokens:13600,keepRecentTokens:231200}}}},({path,options})=>{
 const before=readFileSync(path,'utf8'),p=inspectSetup(options());assert.equal(p.kind,'ready');assert.deepEqual(p.percentages,{triggerPercent:95,targetPercent:85});assert.equal(commitSetup(options(),{fingerprint:p.fingerprint}),null);assert.equal(readFileSync(path,'utf8'),before);
}));
test('custom ACM percentages retained; a new model initializes without disturbing previous model/global defaults',()=>fixture({acm:{triggerPercent:80,targetPercent:60,extra:'preserve'},compaction:{enabled:true,reserveTokens:16384,keepRecentTokens:20000}},({path,options})=>{
 let p=inspectSetup(options());assert.equal(p.kind,'automatic');commitSetup(options(),{fingerprint:p.fingerprint});
 const saved=JSON.parse(readFileSync(path));assert.equal(saved.acm.extra,'preserve');assert.equal(saved.acm.triggerPercent,80);assert.equal(saved.acm.targetPercent,60);assert.equal(saved.compaction.reserveTokens,16384);assert.equal(saved.compaction.keepRecentTokens,20000);
 const next={...options(),model:{...model,id:'another',contextWindow:512000}};p=inspectSetup(next);assert.equal(p.kind,'automatic');commitSetup(next,{fingerprint:p.fingerprint});
 const updated=JSON.parse(readFileSync(path));assert.deepEqual(updated.compaction.modelOverrides['fixture/luna'],saved.compaction.modelOverrides['fixture/luna']);assert.deepEqual(updated.compaction.modelOverrides['fixture/another'],{reserveTokens:102400,keepRecentTokens:307200});
}));
test('owned budgets can follow changed ratio; explicit foreign current-model/global values require consent',()=>fixture({},({path,options})=>{
 let p=inspectSetup(options());commitSetup(options(),{fingerprint:p.fingerprint});let s=JSON.parse(readFileSync(path));s.acm.triggerPercent=90;writeFileSync(path,JSON.stringify(s));p=inspectSetup(options());assert.equal(p.kind,'automatic');commitSetup(options(),{fingerprint:p.fingerprint});
 s=JSON.parse(readFileSync(path));s.compaction.modelOverrides['fixture/luna'].reserveTokens=999;s.compaction.modelOverrides['fixture/luna'].extra='keep';writeFileSync(path,JSON.stringify(s));const before=readFileSync(path,'utf8');p=inspectSetup(options());assert.equal(p.kind,'conflict');assert.throws(()=>commitSetup(options(),{fingerprint:p.fingerprint}),/確認/);assert.equal(readFileSync(path,'utf8'),before);commitSetup(options(),{fingerprint:p.fingerprint,confirmed:true});assert.equal(JSON.parse(readFileSync(path)).compaction.modelOverrides['fixture/luna'].extra,'keep');
}));
test('explicit disabled or custom global compaction never silently overwritten',()=>{
 for(const c of [{enabled:false},{reserveTokens:12345},{keepRecentTokens:12345}])fixture({compaction:c},({path,options})=>{const p=inspectSetup(options());assert.equal(p.kind,'conflict');const before=readFileSync(path,'utf8');assert.throws(()=>commitSetup(options(),{fingerprint:p.fingerprint}),/確認/);assert.equal(readFileSync(path,'utf8'),before);});
});
test('trusted project conflict blocks global write; untrusted malformed project is never read',()=>fixture({},({root,path,options})=>{
 mkdirSync(join(root,'.pi'));writeFileSync(join(root,'.pi/settings.json'),JSON.stringify({compaction:{enabled:false}}));
 const opts={...options(),projectTrusted:true,runtimeSettings:{compaction:{enabled:false}}};const p=inspectSetup(opts);assert.equal(p.kind,'blocked');assert.throws(()=>commitSetup(opts,{fingerprint:p.fingerprint,confirmed:true}),/專案/);assert.equal(readFileSync(path,'utf8'),'{}');
 writeFileSync(join(root,'.pi/settings.json'),'not-json');assert.equal(inspectSetup(options()).kind,'automatic');
}));
test('project percentages never overwrite global preferences, even after consent',()=>fixture({acm:{triggerPercent:95,targetPercent:85}},({root,path,options})=>{
 mkdirSync(join(root,'.pi'));writeFileSync(join(root,'.pi/settings.json'),JSON.stringify({acm:{triggerPercent:80,targetPercent:70}}));
 const opts={...options(),projectTrusted:true,runtimeSettings:{acm:{triggerPercent:80,targetPercent:70}}},p=inspectSetup(opts),before=readFileSync(path,'utf8');assert.equal(p.kind,'blocked');assert.throws(()=>commitSetup(opts,{fingerprint:p.fingerprint,confirmed:true}),/全域比例/);assert.equal(readFileSync(path,'utf8'),before);
}));
test('malformed global tokens or enabled value are blocked, not hidden by a new override',()=>{
 for(const compaction of[{reserveTokens:-1},{keepRecentTokens:NaN},{enabled:'false'}])fixture({compaction},({options,path})=>{const p=inspectSetup(options());assert.equal(p.kind,'blocked');const before=readFileSync(path,'utf8');assert.throws(()=>commitSetup(options(),{fingerprint:p.fingerprint,confirmed:true}),/無效/);assert.equal(readFileSync(path,'utf8'),before);});
});
test('consent invalidated by intervening file/model changes; existing lock remains untouched',()=>fixture({},({path,options})=>{
 const p=inspectSetup(options());writeFileSync(path,JSON.stringify({theme:'changed'}));assert.throws(()=>commitSetup(options(),{fingerprint:p.fingerprint,confirmed:true}),/變更/);assert.deepEqual(JSON.parse(readFileSync(path)),{theme:'changed'});
 const p2=inspectSetup(options());assert.throws(()=>commitSetup({...options(),model:{...model,id:'different'}},{fingerprint:p2.fingerprint}),/變更/);
 mkdirSync(path+'.lock');assert.throws(()=>commitSetup(options(),{fingerprint:p2.fingerprint}),/鎖定/);rmSync(path+'.lock',{recursive:true});
}));
test('setup rollback restores exact original bytes but never clobbers a later writer',()=>fixture({},({path,options})=>{
 const before=readFileSync(path,'utf8');let p=inspectSetup(options()),receipt=commitSetup(options(),{fingerprint:p.fingerprint});rollbackConfig(receipt);assert.equal(readFileSync(path,'utf8'),before);
 p=inspectSetup(options());receipt=commitSetup(options(),{fingerprint:p.fingerprint});writeFileSync(path,JSON.stringify({theme:'another-writer'}));assert.throws(()=>rollbackConfig(receipt),/後續變更/);assert.deepEqual(JSON.parse(readFileSync(path)),{theme:'another-writer'});
}));
