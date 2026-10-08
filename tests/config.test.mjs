import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PERCENTAGES, parseConfigCommand, validatePercentages, policyForSettings,
  nativeBudget, assertNativeSettings, patchSettings, commitConfig, rollbackConfig, atomicReplace } from '../src/config.mjs';
import { fromHost } from './runtime.mjs';
const { loadExtensions } = await fromHost('dist/core/extensions/loader.js');
const { createEventBus } = await fromHost('dist/core/event-bus.js');
const guard = fileURLToPath(new URL('../extensions/no-summary-guard.ts', import.meta.url));
const base = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8'));
const model = { provider: 'fixture', id: 'model', contextWindow: 272000 };
const settings = { theme: 'unchanged', packages: ['fixture-only'], defaultModel: 'untouched',
  compaction: { enabled: true, reserveTokens: 54400, keepRecentTokens: 190400,
    modelOverrides: { 'another/model': { reserveTokens: 123, keepRecentTokens: 456 } } } };
const percentages = { triggerPercent: 85, targetPercent: 75 };

function diskFixture(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acm-config-unit-'));
  const path = join(cwd, 'settings.json');
  const before = JSON.stringify(settings, null, 2);
  writeFileSync(path, before);
  const options = { cwd, path, projectTrusted: false, runtimeSettings: structuredClone(settings), model, base, percentages };
  try { return run({ cwd, path, before, options }); } finally { rmSync(cwd, { recursive: true, force: true }); }
}

test('config parses display/reset, decimals and optional percent signs, rejects nonfinite/malformed/range input', () => {
  assert.equal(parseConfigCommand(' '), null);
  assert.deepEqual(parseConfigCommand('reset'), DEFAULT_PERCENTAGES);
  assert.deepEqual(parseConfigCommand(' 85 75 '), percentages);
  assert.deepEqual(parseConfigCommand('80.5% 70.25%'), { triggerPercent: 80.5, targetPercent: 70.25 });
  for (const value of ['80', 'reset extra', '80 80', '70 80', '100 70', '80 0', '-1 70', 'NaN 70', 'Infinity 70', '0x50 70', '1e2 70', '80 70 extra']) {
    assert.throws(() => parseConfigCommand(value), /比例|用法/);
  }
  for (const triggerPercent of [NaN, Infinity, null, '80', 100, 0]) {
    assert.throws(() => validatePercentages({ triggerPercent, targetPercent: 70 }), /比例/);
  }
  for (const acm of [null, [], {}, { triggerPercent: 80 }, { triggerPercent: 70, targetPercent: 80 }]) {
    assert.throws(() => policyForSettings(base, { acm }), /比例/);
  }
  assert.equal(policyForSettings(base, {}).triggerRatio, 0.8);
  assert.equal(policyForSettings(base, { acm: percentages }).targetRatio, 0.75);
  assert.throws(() => policyForSettings({ ...base, noSummary: false }, {}), /no summary fallback/);
});

test('native reserve accounts for original model capacity above the ACM cap, with exact integer rounding', () => {
  const policy = policyForSettings(base, { acm: percentages });
  assert.deepEqual(nativeBudget(model, policy), { capacity: 272000, trigger: 231200, target: 204000, reserve: 40800 });
  assert.deepEqual(nativeBudget({ ...model, contextWindow: 2000000 }, policy),
    { capacity: 1050000, trigger: 892500, target: 787500, reserve: 1107500 });
  const small = nativeBudget({ ...model, contextWindow: 12345 }, policy);
  assert.equal(small.trigger, Math.floor(12345 * 0.85));
  assert.equal(small.reserve + small.trigger, 12345);
  for (const contextWindow of [0, -1, NaN, Infinity, 1.5]) assert.throws(() => nativeBudget({ ...model, contextWindow }, policy));
});

test('settings patch preserves unrelated values and other model overrides, synchronizes current model and validates both native fields', () => {
  const before = JSON.stringify(settings);
  const next = patchSettings(settings, model, base, percentages);
  assert.equal(JSON.stringify(settings), before, 'input is never mutated');
  assert.deepEqual(next.packages, settings.packages);
  assert.equal(next.defaultModel, settings.defaultModel);
  assert.equal(next.theme, settings.theme);
  assert.deepEqual(next.compaction.modelOverrides['another/model'], settings.compaction.modelOverrides['another/model']);
  assert.deepEqual(next.compaction.modelOverrides['fixture/model'], { reserveTokens: 40800, keepRecentTokens: 204000 });
  const policy = policyForSettings(base, next);
  assert.equal(assertNativeSettings(next, model, policy).trigger, 231200);
  assert.throws(() => assertNativeSettings(settings, model, policy), /compaction/);
  const wrong = structuredClone(next);
  wrong.compaction.modelOverrides['fixture/model'].keepRecentTokens--;
  assert.throws(() => assertNativeSettings(wrong, model, policy), /compaction/);
});

test('single atomic commit stores policy/native settings together; rollback restores the exact original bytes', () => diskFixture(({ path, before, options, cwd }) => {
  const receipt = commitConfig(options);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(saved.acm, percentages);
  assertNativeSettings(saved, model, policyForSettings(base, saved));
  assert.deepEqual(readdirSync(cwd), ['settings.json']);
  rollbackConfig(receipt);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readdirSync(cwd), ['settings.json']);
}));

test('post-commit lock cleanup failure retains a successful receipt, allowing reload instead of a half-applied save', () => diskFixture(({ path, before, options }) => {
  const receipt = commitConfig({ ...options, releaseLock: () => { throw new Error('Injected lock cleanup failure'); } });
  assert.match(receipt.lockCleanupWarning, /lock 清理失敗/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).acm, percentages);
  assert.equal(existsSync(`${path}.lock`), true, 'unclean resource is retained, not force-released');
  rmSync(`${path}.lock`, { recursive: true }); // exact disposable fixture-owned lock
  rollbackConfig(receipt);
  assert.equal(readFileSync(path, 'utf8'), before);
}));

test('write failure, existing Pi lock, malformed JSON and stale runtime never overwrite original settings', () => diskFixture(({ path, before, options }) => {
  assert.throws(() => commitConfig({ ...options, replace: () => { throw new Error('Injected disk-full error'); } }), /disk-full/);
  assert.equal(readFileSync(path, 'utf8'), before);
  mkdirSync(`${path}.lock`);
  assert.throws(() => commitConfig(options), /無法鎖定/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(existsSync(`${path}.lock`), true, 'another owner\'s lock is retained');
  rmSync(`${path}.lock`, { recursive: true });
  writeFileSync(path, '{bad json');
  assert.throws(() => commitConfig(options));
  assert.equal(readFileSync(path, 'utf8'), '{bad json');
  writeFileSync(path, before);
  assert.throws(() => commitConfig({ ...options, runtimeSettings: { ...settings, acm: percentages } }), /磁碟與執行中/);
  assert.equal(readFileSync(path, 'utf8'), before);
}));

test('atomic replacement rejects drift after staging and cleans its temporary file; rollback never clobbers newer edits', () => diskFixture(({ path, before, options, cwd }) => {
  assert.throws(() => atomicReplace(path, 'candidate', 'wrong expected original'), /Settings changed/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.deepEqual(readdirSync(cwd), ['settings.json']);
  const receipt = commitConfig(options);
  const newer = `${receipt.after}\n`;
  writeFileSync(path, newer);
  assert.throws(() => rollbackConfig(receipt), /後續變更/);
  assert.equal(readFileSync(path, 'utf8'), newer);
}));

test('trusted conflicting project ratios or native settings reject without writing either file; untrusted settings are not read', () => diskFixture(({ path, before, options, cwd }) => {
  mkdirSync(join(cwd, '.pi'));
  const projectPath = join(cwd, '.pi', 'settings.json');
  const project = { acm: { triggerPercent: 90, targetPercent: 80 } };
  writeFileSync(projectPath, JSON.stringify(project));
  assert.throws(() => commitConfig({ ...options, projectTrusted: true, runtimeSettings: { ...settings, ...project } }), /專案 ACM/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readFileSync(projectPath, 'utf8'), JSON.stringify(project));
  writeFileSync(projectPath, JSON.stringify({ compaction: { enabled: false } }));
  assert.throws(() => commitConfig({ ...options, projectTrusted: true,
    runtimeSettings: { ...settings, compaction: { ...settings.compaction, enabled: false } } }), /compaction/);
  assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(projectPath, '{untrusted malformed json');
  const receipt = commitConfig(options);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).acm, percentages);
  rollbackConfig(receipt);
}));

test('guard loads without a tokenizer or base policy and still cancels every summary path and aborts requests', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acm-guard-missing-policy-'));
  try {
    mkdirSync(join(cwd, 'extensions'));
    mkdirSync(join(cwd, 'src'));
    const path = join(cwd, 'extensions', 'no-summary-guard.ts');
    cpSync(guard, path);
    cpSync(fileURLToPath(new URL('../src/config.mjs', import.meta.url)), join(cwd, 'src', 'config.mjs'));
    const bus = createEventBus();
    const loaded = await loadExtensions([path], cwd, bus);
    assert.deepEqual(loaded.errors, []);
    loaded.runtime.getSettings = () => ({});
    const handlers = loaded.extensions[0].handlers;
    for (const reason of ['threshold', 'overflow', 'manual']) {
      assert.deepEqual(handlers.get('session_before_compact')[0]({ reason }), { cancel: true });
    }
    assert.deepEqual(handlers.get('session_before_tree')[0]({ preparation: { userWantsSummary: true } }), { cancel: true });
    const messages = [{ role: 'user', content: 'Missing producer/policy fixture.' }];
    bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 1 });
    let aborts = 0;
    assert.throws(() => handlers.get('context_with_system')[0]({ messages }, { model, abort: () => { aborts++; } }), /aborted/);
    assert.equal(aborts, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('independent guard uses configured thresholds above and below 80%, validates malformed config and remains one-shot', async () => {
  const bus = createEventBus();
  const loaded = await loadExtensions([guard], tmpdir(), bus);
  assert.deepEqual(loaded.errors, []);
  let acm = { triggerPercent: 90, targetPercent: 80 };
  loaded.runtime.getSettings = () => ({ acm });
  const callback = loaded.extensions[0].handlers.get('context_with_system')[0];
  const messages = [{ role: 'user', content: 'Mock guard verification, no provider.' }];
  let aborts = 0;
  const ctx = { model, abort: () => { aborts++; } };
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 230000 });
  assert.equal(callback({ messages }, ctx), undefined, 'configured 90% must not keep the old fixed 80% guard');
  assert.throws(() => callback({ messages }, ctx), /aborted/);
  acm = { triggerPercent: 75, targetPercent: 65 };
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 204001 });
  assert.throws(() => callback({ messages }, ctx), /aborted/);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 204000 });
  assert.equal(callback({ messages }, ctx), undefined);
  const copy = structuredClone(messages);
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 204000 });
  assert.throws(() => callback({ messages: copy }, ctx), /aborted/, 'approval is exact message-array identity');
  acm = { triggerPercent: 100, targetPercent: 70 };
  bus.emit('acm-passive:request-ready', { messages, estimatedTokens: 1 });
  assert.throws(() => callback({ messages }, ctx), /aborted/);
  assert.deepEqual(loaded.extensions[0].handlers.get('session_before_compact')[0]({ reason: 'overflow' }), { cancel: true });
  assert.equal(aborts, 4);
});
