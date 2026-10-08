import test from 'node:test';
import assert from 'node:assert/strict';
import { countTokens } from 'gpt-tokenizer';
import { DEFAULT_POLICY as P, MARKER, budgets, validatePolicy, createCounter, previewMessage,
  selectWindow, assertPairing, atomicGroups, branchState, applyCursor, messageKey } from '../src/window.mjs';

const row = (id, role, content) => ({ id, message: { role, content, timestamp: Number(id.replace(/\D/g, '')) || 1 } });
const tc = (id, name = 'read') => ({ type: 'toolCall', id, name, arguments: { path: `file-${id}` } });
const tr = (id, text = 'ok') => ({ id: `result-${id}`, message: { role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text }] } });
const deterministic = { tokens: m => m.testTokens ?? 20 };
const policy = { ...P, requestMargin: 20 };
function weighted(id, n, role = 'assistant') { return { id, message: { role, content: [{ type: 'text', text: id }], testTokens: n } }; }

test('272k gives 231200 trigger / 204000 target / 40800 reserve', () => {
  assert.deepEqual(budgets(272000), { capacity: 272000, trigger: 231200, target: 204000, reserve: 40800 });
  assert.equal(budgets(1000000).capacity, 272000);
  assert.throws(() => validatePolicy({ ...P, noSummary: false }));
  assert.throws(() => budgets(null));
});

test('no slide below threshold, chronological tail near 75% above it', () => {
  const rows = Array.from({ length: 24 }, (_, i) => weighted(`r${i}`, 10000));
  let plan = selectWindow(rows.slice(0, 20), deterministic, 272000, policy);
  assert.equal(plan.changed, false);
  plan = selectWindow(rows, deterministic, 272000, policy);
  assert.equal(plan.changed, true);
  assert.equal(plan.firstKeptId, 'r4');
  assert.ok(plan.after <= 204000);
  assert.ok(plan.after > 190000);
});

test('native observed trigger still slides when visible-text estimate is below 75%', () => {
  const rows = Array.from({ length: 19 }, (_, i) => weighted(`r${i}`, 10000));
  const ordinary = selectWindow(rows, deterministic, 272000, policy);
  assert.equal(ordinary.changed, false);
  const forced = selectWindow(rows, deterministic, 272000, policy, [], 0, true);
  assert.equal(forced.changed, true);
  assert.ok(forced.after < 190000 * 0.75 / 0.85);
  assert.equal(forced.rows.at(-1).id, 'r18');
});

test('split user span retains exact latest user and explicit task anchor', () => {
  const rows = [weighted('goal', 4000, 'user'), weighted('clarification', 3000, 'user'),
    ...Array.from({ length: 28 }, (_, i) => weighted(`r${i}`, 10000))];
  const plan = selectWindow(rows, deterministic, 272000, policy, ['goal']);
  assert.ok(plan.rows.some(r => r.id === 'goal'));
  assert.ok(plan.rows.some(r => r.id === 'clarification'));
  assert.ok(plan.carriedIds.includes('goal'));
  assert.ok(plan.carriedIds.includes('clarification'));
  assert.ok(!['goal', 'clarification'].includes(plan.firstKeptId));
});

test('parallel/interleaved calls are one interval, never orphaned or partially dropped', () => {
  const batch = [row('a1', 'assistant', [tc('x'), tc('y')]), tr('x'), row('u1', 'user', 'steer'), tr('y')];
  assert.equal(atomicGroups(batch).length, 1);
  const rows = [...Array.from({ length: 30 }, (_, i) => weighted(`old${i}`, 10000)), ...batch, weighted('final', 20)];
  const plan = selectWindow(rows, deterministic, 272000, policy);
  for (const r of batch) assert.ok(plan.rows.some(x => x.id === r.id));
  assertPairing(plan.rows.map(r => r.message));
});

test('incomplete/orphaned/duplicate batches fail closed without synthetic repair', () => {
  assert.throws(() => atomicGroups([row('a1', 'assistant', [tc('x'), tc('y')]), tr('x')]), /Incomplete/);
  assert.throws(() => atomicGroups([tr('x')]), /Orphan/);
  assert.throws(() => atomicGroups([row('a1', 'assistant', [tc('x')]), tr('x'), tr('x')]), /Duplicate/);
});

test('essential user/fixed prompt too large aborts rather than dropping or sending empty context', () => {
  assert.throws(() => selectWindow([weighted('user', 235000, 'user'), weighted('last', 100)], deterministic, 272000, policy), /Protected/);
  assert.throws(() => selectWindow([weighted('last', 100)], deterministic, 272000, policy, [], 240000), /Protected/);
  assert.throws(() => selectWindow([], deterministic, 272000, policy), /empty/);
});

test('huge tool text is only previewed; raw bytes, images, flags and error tail remain intact', () => {
  const raw = { role: 'toolResult', toolCallId: 'x', toolName: 'read', isError: true,
    details: { exact: 'kept' }, content: [{ type: 'text', text: '原始繁體中文'.repeat(30000) + '\nERROR: actual failure tail' },
      { type: 'image', data: 'unchanged-base64', mimeType: 'image/png' }] };
  const before = JSON.stringify(raw);
  const shown = previewMessage(raw, P, '/tmp/session.jsonl');
  assert.ok(countTokens(shown.content[0].text, { allowedSpecial: 'all' }) <= 4096);
  assert.match(shown.content[0].text, /preview only/);
  assert.match(shown.content[0].text, /actual failure tail/);
  assert.deepEqual(shown.content[1], raw.content[1]);
  assert.equal(shown.isError, true);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(previewMessage(structuredClone(raw), P, '/tmp/session.jsonl'), shown);
});

test('incremental cache is bounded and does not tokenize metadata or base64', () => {
  const counter = createCounter({ ...P, cacheEntries: 2 });
  const message = { role: 'toolResult', content: [{ type: 'text', text: 'hi' }], details: { massive: 'x'.repeat(100000) } };
  const first = counter.tokens(message);
  assert.equal(counter.tokens({ ...message, details: { other: 'y'.repeat(200000) } }), first);
  assert.equal(counter.stats().misses, 1);
  counter.tokens({ role: 'user', content: 'two' });
  counter.tokens({ role: 'user', content: 'three' });
  assert.equal(counter.stats().size, 2);
  assert.equal(messageKey(message), messageKey(structuredClone(message)));
});

test('cursor survives restart, is branch-relative and does not revive old pressure breadcrumbs', () => {
  const branch = ['a', 'b', 'c', 'd'].map(id => ({ type: 'message', id }));
  branch.push({ type: 'custom', id: 's', customType: 'acm-passive', data: { cursorId: 'c', carriedIds: ['a'] } });
  const rows = ['a', 'b', 'c', 'd'].map(id => row(id, 'user', id));
  const { state } = branchState(branch);
  assert.deepEqual(applyCursor(rows, state, branch).map(r => r.id), ['a', 'c', 'd']);
  assert.equal(branchState(branch.slice(0, 2)).state.cursorId, null);
  assert.throws(() => applyCursor(rows, { ...state, cursorId: 'missing' }, branch), /missing/);
  assert.equal(branchState([{ type: 'custom', customType: 'acm', data: { prunedManifest: [{ id: 'a', reason: 'pressure' }] } }]).state.cursorId, null);
});

test('many sliding cycles stay bounded and preserve pairing plus exact task', () => {
  const counter = createCounter();
  let rows = [row('task', 'user', 'Exact task: keep existing verified outputs; no replay.')];
  let slides = 0;
  for (let i = 0; i < 180; i++) {
    const call = `call-${i}`;
    rows.push(row(`a${i}`, 'assistant', [tc(call)]), { ...tr(call, 'known-output '.repeat(1200)), id: `t${i}` });
    rows = rows.map(r => ({ ...r, message: previewMessage(r.message) }));
    const plan = selectWindow(rows, counter, 272000, P, ['task'], 16000);
    if (plan.changed) slides++;
    rows = plan.rows;
    assert.ok(plan.after <= 231200);
    assert.ok(rows.some(r => r.id === 'task'));
    assertPairing(rows.map(r => r.message));
  }
  assert.ok(slides >= 5);
  assert.ok(counter.stats().size <= P.cacheEntries);
  assert.ok(MARKER.includes('No AI summary'));
});
