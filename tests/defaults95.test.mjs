import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_POLICY, budgets } from '../src/window.mjs';
import { DEFAULT_PERCENTAGES, parseConfigCommand, policyForSettings, nativeBudget } from '../src/config.mjs';
const base=JSON.parse(readFileSync(new URL('../policy.json',import.meta.url)));
test('fresh/default/reset95/85 agree across engine, policy, producer/guard config and native budgets',()=>{
  assert.deepEqual(DEFAULT_PERCENTAGES,{triggerPercent:95,targetPercent:85});
  assert.deepEqual(parseConfigCommand('reset'),DEFAULT_PERCENTAGES);
  assert.equal(DEFAULT_POLICY.triggerRatio,0.95);assert.equal(DEFAULT_POLICY.targetRatio,0.85);
  const policy=policyForSettings(base,{});
  assert.equal(policy.triggerRatio,0.95);assert.equal(policy.targetRatio,0.85);
  assert.deepEqual(budgets(272000,policy),{capacity:272000,trigger:258400,target:231200,reserve:13600});
  assert.deepEqual(nativeBudget({contextWindow:272000},policy),{capacity:272000,trigger:258400,target:231200,reserve:13600});
  const custom=policyForSettings(base,{acm:{triggerPercent:80,targetPercent:60}});
  assert.equal(custom.triggerRatio,0.8);assert.equal(custom.targetRatio,0.6,'An upgrade must not overwrite explicit user percentages');
});
