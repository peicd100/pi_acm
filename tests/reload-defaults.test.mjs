import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {fromHost} from './runtime.mjs';
const {loadExtensionsCached,clearExtensionCache}=await fromHost('dist/core/extensions/loader.js');
const {createEventBus}=await fromHost('dist/core/event-bus.js');
const source=fileURLToPath(new URL('../',import.meta.url));
test('same-process reload switches cached95/85 guard and selector to versioned70/55 without resurrecting native ESM defaults',async()=>{
 const root=await mkdtemp(join(tmpdir(),'acm default reload '));
 try {
  await mkdir(join(root,'src'));await mkdir(join(root,'extensions'));
  await writeFile(join(root,'package.json'),JSON.stringify({type:'module'}));
  await writeFile(join(root,'policy.json'),await readFile(join(source,'policy.json')));
  await writeFile(join(root,'src/config.mjs'),await readFile(join(source,'src/config_v1.4.2.mjs')));
  const guard=await readFile(join(source,'extensions/no-summary-guard.ts'),'utf8');
  const path=join(root,'extensions/no-summary-guard.ts');
  await writeFile(path,guard.replace('../src/config_v1.4.4.mjs','../src/config.mjs'));
  const load=async()=>{const bus=createEventBus();const loaded=await loadExtensionsCached([path],root,bus);assert.deepEqual(loaded.errors,[]);loaded.runtime.getSettings=()=>({});return {bus,loaded,callback:loaded.extensions[0].handlers.get('context_with_system')[0]};};
  const messages=[{role:'user',content:'Fixture only; no model request'}];
  const ctx={model:{contextWindow:100000},abort:()=>{}};
  let loaded=await load();loaded.bus.emit('acm-passive:request-ready',{messages,estimatedTokens:95000});
  assert.equal(loaded.callback({messages},ctx),undefined);
  const cached=await import(pathToFileURL(join(root,'src/config.mjs')).href);
  assert.equal(cached.DEFAULT_PERCENTAGES.triggerPercent,95);
  await writeFile(join(root,'src/config_v1.4.4.mjs'),await readFile(join(source,'src/config_v1.4.4.mjs')));await writeFile(path,guard);
  clearExtensionCache();loaded=await load();loaded.bus.emit('acm-passive:request-ready',{messages,estimatedTokens:95000});
  assert.throws(()=>loaded.callback({messages},ctx),/aborted/);
  loaded.bus.emit('acm-passive:request-ready',{messages,estimatedTokens:70000});assert.equal(loaded.callback({messages},ctx),undefined);
  assert.equal((await import(pathToFileURL(join(root,'src/config_v1.4.4.mjs')).href)).DEFAULT_PERCENTAGES.triggerPercent,70);
  assert.equal((await import(pathToFileURL(join(root,'src/config.mjs')).href)).DEFAULT_PERCENTAGES.triggerPercent,95);
  loaded.loaded.runtime.getSettings=()=>({acm:{triggerPercent:95,targetPercent:85}});
  loaded.bus.emit('acm-passive:request-ready',{messages,estimatedTokens:95000});assert.equal(loaded.callback({messages},ctx),undefined,'Explicit old95/85 must still work after upgrade');
  const legacy=await import('../src/window_v1.4.1.mjs'),current=await import('../src/window_v1.4.4.mjs');assert.equal(legacy.DEFAULT_POLICY.triggerRatio,.95);assert.equal(current.DEFAULT_POLICY.triggerRatio,.7);assert.equal(current.DEFAULT_POLICY.targetRatio,.55);
 } finally {clearExtensionCache();await rm(root,{recursive:true,force:true});}
});
