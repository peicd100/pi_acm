// Maximum-context trial and smaller-window compatibility. Former512K inputs remain covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { budgets, validatePolicy, DEFAULT_POLICY, selectWindow } from '../src/window.mjs';
import { ai, fromHost } from './runtime.mjs';
const { ModelRuntime } = await fromHost('dist/core/model-runtime.js');
const { InMemoryCredentialStore } = ai;
const { loadExtensions } = await fromHost('dist/core/extensions/loader.js');
const { createEventBus } = await fromHost('dist/core/event-bus.js');
const guard = fileURLToPath(new URL('../extensions/no-summary-guard.ts', import.meta.url));
const policy = validatePolicy(JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8')));

test('max trial cap95/85 and ratios preserve lower-model and historical default limits', () => {
  assert.deepEqual(budgets(1050000, policy), { capacity: 1050000, trigger: 997500, target: 892500, reserve: 52500 });
  assert.deepEqual(budgets(512000, policy), { capacity: 512000, trigger: 486400, target: 435200, reserve: 25600 });
  assert.deepEqual(budgets(272000, policy), { capacity: 272000, trigger: 258400, target: 231200, reserve: 13600 });
  assert.equal(budgets(2000000, policy).capacity, 1050000);
  assert.equal(DEFAULT_POLICY.contextCap, 272000, 'Pure-engine historical fixtures retain their explicit default');
});

test('isolated client model-window fixtures do not depend on or alter personal models/settings/auth', async () => {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const base = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  const original = JSON.stringify(base);
  for (const capacity of [272000, 512000, 1050000]) {
    const fixture = { ...base, contextWindow: capacity };
    const b = budgets(fixture.contextWindow, policy);
    assert.equal(b.capacity, capacity);
    assert.equal(b.trigger + b.reserve, capacity);
    assert.equal(b.target, Math.floor(capacity * 0.85));
  }
  assert.equal(JSON.stringify(base), original);
  // Explicit fixture metadata is not an assertion about the signed-in backend.
});

test('maximum independent guard permits approved95 percent, remains one-shot and caps lower/higher models', async () => {
  const bus = createEventBus();
  const loaded = await loadExtensions([guard], '/tmp', bus);
  loaded.runtime.getSettings = () => ({});
  assert.deepEqual(loaded.errors, []);
  const callback = loaded.extensions[0].handlers.get('context_with_system')[0];
  let aborts = 0;
  const ctx = { model: { contextWindow: 1050000 }, abort: () => { aborts++; } };
  const messages = [{ role: 'user', content: 'Local fixture only; no provider request.' }];
  assert.throws(() => callback({ messages }, ctx), /aborted/);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 997500 });
  assert.equal(callback({ messages }, ctx), undefined);
  assert.throws(() => callback({ messages }, ctx), /aborted/, 'approval cannot be replayed');
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 997501 });
  assert.throws(() => callback({ messages }, ctx), /aborted/);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 997501 });
  assert.throws(() => callback({ messages }, { ...ctx, model: { contextWindow: 2000000 } }), /aborted/);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 486400 });
  assert.equal(callback({ messages }, { ...ctx, model: { contextWindow: 512000 } }), undefined);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 486401 });
  assert.throws(() => callback({ messages }, { ...ctx, model: { contextWindow: 512000 } }), /aborted/);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 258401 });
  assert.throws(() => callback({ messages }, { ...ctx, model: { contextWindow: 272000 } }), /aborted/);
  assert.equal(aborts, 6);
  assert.deepEqual(loaded.extensions[0].handlers.get('session_before_compact')[0]({ reason: 'overflow' }), { cancel: true });
});

test('maximum selector slides above95 percent and retains85 percent, protected unknown still aborts', () => {
  const rows = Array.from({ length: 53 }, (_, i) => ({ id: `trial-${i}`,
    message: { role: 'user', content: `Synthetic weighted fixture ${i}; no padded text.`, testTokens: 20000 } }));
  const counter = { tokens: message => message.testTokens ?? 20 };
  const selected = selectWindow(rows, counter, 1050000, policy);
  assert.equal(selected.changed, true);
  assert.ok(selected.after <= 892500);
  assert.ok(selected.rows.some(row => row.id === rows.at(-1).id));
  assert.equal(selectWindow(rows.slice(0, 40), counter, 1050000, policy).changed, false);
  assert.throws(() => selectWindow([{ id: 'essential', message: { role: 'user', testTokens: 997501 } }],
    counter, 1050000, policy), /Protected/);
});
