import test from 'node:test';
import assert from 'node:assert/strict';
import * as window from '../src/window.mjs';
import { createCalibration, modelKey } from '../src/calibration_v1.4.3.mjs';
const P = { ...window.DEFAULT_POLICY, triggerRatio: 0.85, targetRatio: 0.75, requestMargin: 20 };
const counter = { tokens: m => m.weight ?? 20 };
const row = (id, weight, role = 'assistant') => ({ id, message: { role, weight, content: [{ type: 'text', text: id }] } });

test('every unknown/invalid cost blocks even for an optional old group; never a crop signal', () => {
  for (const n of [Infinity, NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => window.selectWindow([row('unknown-old', n), row('continue', 20, 'user')], counter, 272000, P), /Unknown\/invalid/);
  }
});

test('invalid fixed and marker budgets cannot produce a cutting plan', () => {
  for (const n of [Infinity, NaN, -1]) assert.throws(() => window.selectWindow([row('u', 20, 'user')], counter, 272000, P, [], n), /Unknown\/invalid/);
  const badMarker = { tokens: m => m.role === 'compactionSummary' ? Infinity : m.weight };
  assert.throws(() => window.selectWindow([row('a', 130000), row('u', 130000, 'user')], badMarker, 272000, P), /marker/);
});

test('uncheckpointed complete working span is retained even above the target', () => {
  const rows = [row('closed-old', 100000), row('work-start', 1, 'user'), row('unrecorded-middle', 170000), row('latest-output', 40000)];
  const plan = window.selectWindow(rows, counter, 272000, P, [], 0, false, 'work-start');
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.rows.map(r => r.id), ['work-start', 'unrecorded-middle', 'latest-output']);
  assert.ok(plan.after <= window.budgets(272000, P).trigger);
});

test('working span over the safe limit stops, rather than dropping its middle', () => {
  const rows = [row('work-start', 1000, 'user'), ...Array.from({ length: 9 }, (_, i) => row('unrecorded-' + i, 30000))];
  assert.throws(() => window.selectWindow(rows, counter, 272000, P, [], 0, false, 'work-start'), /Protected context/);
});

test('missing work boundary is not reset to the newest continue message', () => {
  assert.throws(() => window.selectWindow([row('continue', 20, 'user')], counter, 272000, P, [], 0, false, 'missing'), /working-span boundary missing/);
});

test('aborted zero-usage opaque frame is omitted request-locally, valid recent results and raw bytes survive', () => {
  const failed = { id: 'failed', message: { role: 'assistant', stopReason: 'aborted', usage: { output: 0 },
    content: Array.from({ length: 48 }, () => ({ type: 'thinking', thinking: '', thinkingSignature: 'synthetic-opaque-not-decoded' })) } };
  const rows = [row('recent-work', 100, 'user'), row('result', 100), failed, row('continue', 20, 'user')];
  const raw = JSON.stringify(rows);
  const retained = window.omitFailedAttempts(rows);
  assert.deepEqual(retained.map(r => r.id), ['recent-work', 'result', 'continue']);
  const budget = createCalibration().view(modelKey({ provider: 'fixture', api: 'fixture', id: 'fixture' }), counter, P);
  const plan = window.selectWindow(retained, budget, 272000, P, [], 0, false, 'recent-work');
  assert.equal(plan.changed, false);
  assert.equal(JSON.stringify(rows), raw);
});

test('failed tool attempt is uncertain, never discarded, repaired or replayed', () => {
  const rows = [{ id: 'failed-tool', message: { role: 'assistant', stopReason: 'error', content: [{ type: 'toolCall', id: 'x', name: 'write', arguments: {} }] } },
    { id: 'result', message: { role: 'toolResult', toolCallId: 'x', content: [{ type: 'text', text: 'actual result' }] } }];
  const raw = JSON.stringify(rows);
  assert.throws(() => window.omitFailedAttempts(rows), /reconcile execution/);
  assert.equal(JSON.stringify(rows), raw);
});
