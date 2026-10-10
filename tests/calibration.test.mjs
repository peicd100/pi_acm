import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalibration, opaqueBasis, modelKey, promptTokens, nativeUsageTokens, CALIBRATION_TYPE, COUNTING_RULE } from '../src/calibration_v1.4.3.mjs';
import { selectWindow, DEFAULT_POLICY as DEFAULT_P } from '../src/window.mjs';
const P = { ...DEFAULT_P, triggerRatio: 0.85, targetRatio: 0.75 };
const model = { provider: 'fixture', api: 'fixture-api', id: 'model-a' };
const key = modelKey(model);
const base = { tokens: m => m.cost ?? 100 };
const snapshot = (basis = 100000) => ({ requestId: 'request-a', modelKey: key, countingRule:COUNTING_RULE,
  inputFingerprint: 'a'.repeat(64), visibleInputTokens: basis, basisTokens: basis });
const response = (input = 140000, overrides = {}) => ({ role: 'assistant', provider: model.provider,
  api: model.api, model: model.id, stopReason: 'stop', usage: { input: input - Math.min(10000, input),
    cacheRead: Math.min(10000, input), cacheWrite: 0, output: 2000, totalTokens: input + 2000 }, ...overrides });

test('prompt calibration excludes output while Pi native view includes it', () => {
  const u = response().usage;
  assert.equal(promptTokens(u), 140000);
  assert.equal(nativeUsageTokens(u), 142000);
  assert.equal(promptTokens({ input: -1 }), null);
  assert.equal(promptTokens({ input: NaN }), null);
  assert.equal(promptTokens({ input: 0, output: 5000 }), null);
});
test('same-request high-water ratio and safety margin affect actual window budgeting', () => {
  const cal = createCalibration();
  cal.observe(snapshot(), response(), key, 'response-a');
  const budget = cal.view(key, base, P);
  assert.ok(Math.abs(budget.factor - 1.47) < 1e-10);
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: String(i), message: { role: 'assistant', cost: 10000 } }));
  assert.equal(selectWindow(rows, base, 272000, P).changed, false, 'Compare calibration against the same explicit85/75 fixture, not mutable package defaults');
  const plan = selectWindow(rows, budget, 272000, P, [], budget.offset);
  assert.equal(plan.changed, true);
  assert.ok(plan.after <= 204000);
  cal.observe(snapshot(), response(105000), key, 'response-b');
  assert.ok(cal.view(key, base, P).factor >= budget.factor, 'No unsafe downward averaging');
});
test('missing/mismatched request, model switch and aborted/error outputs cannot train calibration', () => {
  const cal = createCalibration();
  for (const [snap, msg, current] of [[null, response(), key], [snapshot(), response(), 'other'],
    [snapshot(), response(140000, { model: 'different' }), key],
    [snapshot(), response(140000, { stopReason: 'aborted' }), key],
    [snapshot(), response(140000, { stopReason: 'error' }), key],
    [snapshot(), response(140000, { usage: {} }), key]]) {
    assert.equal(cal.observe(snap, msg, current, 'r'), null);
  }
  assert.equal(cal.view(key, base, P).samples, 0);
});
test('small samples use bounded additive overhead, not a huge ratio on future large prompts', () => {
  const cal = createCalibration();
  cal.observe(snapshot(100), response(2100), key, 'r');
  const budget = cal.view(key, base, P);
  assert.equal(budget.factor, 1.05);
  assert.equal(budget.offset, 2100);
  assert.equal(budget.total([{ cost: 100000 }]), 2048 + 2100 + 105000);
});
test('opaque replay reserves original output without decoding or changing ciphertext', () => {
  const message = { role: 'assistant', cost: 500, usage: { output: 2400 }, content: [
    { type: 'thinking', thinking: 'short summary', thinkingSignature: 'original opaque bytes' }] };
  const before = JSON.stringify(message);
  assert.equal(opaqueBasis(message, base), 2400);
  assert.equal(JSON.stringify(message), before);
  assert.equal(opaqueBasis({ ...message, usage: { output: 100 } }, base), 500);
});
test('unbudgetable opaque content fails closed, including optional old content', () => {
  const budget = createCalibration().view(key, base, P);
  const unknown = { id: 'unknown', message: { role: 'assistant', content: [
    { type: 'thinking', thinkingSignature: 'unobserved' }] } };
  assert.equal(budget.tokens(unknown.message), Infinity);
  assert.throws(() => selectWindow([{ id: 'user', message: { role: 'user' } }, unknown], budget, 272000), /Unknown\/invalid/);
  assert.throws(() => selectWindow([unknown, { id: 'user', message: { role: 'user' } }], budget, 272000), /Unknown\/invalid/);
});
test('branch replay requires the exact stored response and does not cross model/branch boundaries', () => {
  const cal = createCalibration();const msg = response();
  const record = cal.observe(snapshot(), msg, key, 'r');
  const branch = [{ id: 'r', type: 'message', message: msg },
    { id: 'c', type: 'custom', customType: CALIBRATION_TYPE, data: record }];
  const restored = createCalibration();restored.restore(branch);
  assert.equal(restored.view(key, base, P).samples, 1);
  assert.equal(restored.view(modelKey({ ...model, id: 'model-b' }), base, P).samples, 0);
  restored.restore([]);assert.equal(restored.view(key, base, P).samples, 0);
  assert.throws(() => restored.restore(branch.slice(1)), /binding/);
  assert.throws(() => restored.restore([{ ...branch[0], message: response(120000) }, branch[1]]), /binding/);
  assert.throws(() => restored.restore([branch[0], { ...branch[1], data: { ...record, extra: true } }]), /Invalid/);
});
