import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCounter, assertPairing, MARKER, branchState } from '../src/window.mjs';

import { ai, fromHost } from './runtime.mjs';
const core = await fromHost('dist/index.js');
const { loadExtensions } = await fromHost('dist/core/extensions/loader.js');
const extension = process.env.PI_ACM_TEST_EXTENSION_ROOT
  ? resolve(process.env.PI_ACM_TEST_EXTENSION_ROOT, 'extensions/index.ts')
  : fileURLToPath(new URL('../extensions/index.ts', import.meta.url));
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (model, content, usage = zeroUsage) => ({ role: 'assistant', api: model.api,
  provider: model.provider, model: model.id, content, usage, stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() });

async function fixture({ enabled = true, acm = { triggerPercent: 80, targetPercent: 70 }, fileSettings = false, modelContext = 272000, keepRecentTokens = modelContext === 1050000 ? 735000 : 190400, guardOnly = false, tools = [], sessionManager, uiContext, modelRuntime: reuseRuntime } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'pi-acm-fixture-'));
  const guard = fileURLToPath(new URL('../extensions/no-summary-guard.ts', import.meta.url));
  let extensions = await loadExtensions(guardOnly ? [guard] : [extension, guard], temp);
  assert.deepEqual(extensions.errors, []);
  assert.equal(extensions.extensions[0].tools.size, 0);
  const modelRuntime = reuseRuntime ?? await core.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false });
  // Explicit disposable auth stub, never persisted; real credentials are neither read nor copied.
  modelRuntime.hasConfiguredAuth = () => true;
  modelRuntime.getAuth = async () => ({ auth: { apiKey: 'fixture-only-no-network' }, source: 'FIXTURE' });
  const baseModel = modelRuntime.getModel('openai-codex', 'gpt-6.1-sol');
  const model = { ...baseModel, contextWindow: modelContext }; // explicit client fixture, not backend qualification
  assert.equal(model.contextWindow, modelContext);
  const modelOverrides = modelContext === 1050000 ? {
    'openai-codex/gpt-6.1-sol': { reserveTokens: 210000, keepRecentTokens }
  } : {};
  const settings = { ...(acm ? { acm } : {}), compaction: { enabled, reserveTokens: 54400, keepRecentTokens, modelOverrides }, retry: { enabled: false } };
  if (fileSettings) await writeFile(join(temp, 'settings.json'), JSON.stringify(settings, null, 2));
  const settingsManager = fileSettings ? core.SettingsManager.create(temp, temp) : core.SettingsManager.inMemory(settings);
  const loader = { getExtensions: () => extensions, getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => 'Fixed fixture instructions: preserve task; never perform network operations.',
    getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => { extensions = await loadExtensions(guardOnly ? [guard] : [extension, guard], temp); } };
  const { session } = await core.createAgentSession({ cwd: temp, agentDir: temp, modelRuntime, model,
    thinkingLevel: 'off', settingsManager, sessionManager: sessionManager ?? core.SessionManager.inMemory(temp),
    resourceLoader: loader, tools: tools.map(t => t.name), customTools: tools });
  const errors = [];
  await session.bindExtensions({ mode: 'sdk', onError: error => errors.push(error),
    commandContextActions: { waitForIdle: async () => {}, reload: async () => { await session.reload(); } },
    ...(uiContext ? { uiContext: { setStatus: () => {}, notify: () => {}, ...uiContext } } : {}) });
  const configCommand = async text => {
    // Redirect even the extension's getAgentDir() to this disposable fixture.
    // No actual user's settings/auth/provider are touched.
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = temp;
    try { await session.prompt(text); } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  };
  const teardown = async () => { session.dispose(); await rm(temp, { recursive: true, force: true }); };
  return { session, settingsManager, model, modelRuntime, get extensions() { return extensions; }, temp, teardown, configCommand, errors };
}

function mockStream(f, reply, captured) {
  // No provider is called. Record MAIN wire attempts separately from summary-stream attempts.
  let summaryCalls = 0;
  f.modelRuntime.streamSimple = () => { summaryCalls++; throw new Error('Forbidden summary/model-runtime stream'); };
  f.session.agent.streamFunction = (model, context, options) => {
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (options?.signal?.aborted) {
        stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(model, []), stopReason: 'aborted' } });
        stream.end(); return;
      }
      captured.push(structuredClone(context));
      const message = reply(model, context, captured.length);
      stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
    });
    return stream;
  };
  return () => summaryCalls;
}

test('public Pi loader exposes no ACM model tools or skill, commands stay UI-only', async () => {
  const f = await fixture();
  try {
    assert.equal(f.session.getActiveToolNames().some(n => n.startsWith('acm_')), false);
    assert.deepEqual([...f.extensions.extensions[0].commands.keys()], ['acm-status', 'acm-config', 'acm-setup']);
  } finally { await f.teardown(); }
});

test('percentage-only footer omits token counts and fixed policy while /acm-status retains details without a model call', async () => {
  const statuses = new Map();
  const notices = [];
  const uiContext = { setStatus: (key, text) => statuses.set(key, text), notify: text => notices.push(text) };
  const f = await fixture({ uiContext });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'ok' }]), requests);
  try {
    assert.equal(statuses.get('acm-passive'), `ACM ${f.session.getContextUsage().percent.toFixed(1)}%`);
    await f.session.prompt('Read-only compact-status fixture.');
    assert.match(statuses.get('acm-passive'), /^ACM \d+\.\d%$/);
    assert.doesNotMatch(statuses.get('acm-passive'), /k|\/|→|summary/);
    const percent = Number(statuses.get('acm-passive').match(/[\d.]+/)[0]);
    assert.ok(percent >= 0 && percent <= 80);
    assert.equal(percent, Number(f.session.getContextUsage().percent.toFixed(1)));
    const command = f.extensions.extensions[0].commands.get('acm-status');
    await command.handler('', { ui: uiContext, model: f.model, sessionManager: f.session.sessionManager,
      getContextUsage: () => f.session.getContextUsage() });
    const detail = JSON.parse(notices.at(-1));
    assert.equal(detail.policy.triggerRatio, 0.8);
    assert.equal(detail.policy.targetRatio, 0.7);
    assert.equal(detail.displaySource, 'native-Pi-footer');
    assert.equal(detail.policy.noSummary, true);
    assert.equal(requests.length, 1, 'status command makes no additional model request');
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('one uninterrupted Pi task exceeds capacity many times and slides automatically without checkpoints or confirmations', async () => {
  const tools = ['fixture_one', 'fixture_two'].map(name => ({ name, label: name, description: 'Read-only fixture output',
    parameters: ai.Type.Object({}), execute: async () => ({ content: [{ type: 'text', text: 'fixed diagnostic output '.repeat(1300) }], details: {} }) }));
  let confirmations = 0;
  const notices = [];
  const f = await fixture({ tools, uiContext: { confirm: async () => { confirmations++; return false; }, notify: text => notices.push(text) } });
  const captured = [];
  const counter = createCounter();
  const summaries = mockStream(f, (model, context, n) => {
    const content = n < 90 ? tools.map((t, i) => ({ type: 'toolCall', id: `batch-${n}-${i}`, name: t.name, arguments: {} })) : [{ type: 'text', text: 'fixture task finished' }];
    const measuredInput = counter.total(context.messages);
    const usage = { ...zeroUsage, input: measuredInput, output: 100,
      totalTokens: measuredInput + 100 };
    return assistant(model, content, usage);
  }, captured);
  try {
    await f.session.prompt('Exact current task: preserve verified bytes, no replay, no network.');
    assert.equal(captured.length, 90, 'A single uninterrupted task finishes without manual memory or token gates');
    assert.equal(confirmations, 0);
    assert.equal(notices.some(text => /請先.*交接|checkpoint.*required/i.test(text)), false);
    assert.equal(branchState(f.session.sessionManager.getBranch()).state.checkpointThroughId, null);
    assert.equal(branchState(f.session.sessionManager.getBranch()).state.windowMode, 'automatic');
    for (const request of captured) {
      assertPairing(request.messages);
      assert.ok(counter.total(request.messages) <= 217600);
      assert.ok(request.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Exact current task')));
      assert.ok(request.messages[0].role === 'system');
    }
    assert.equal(summaries(), 0);
    const branch = f.session.sessionManager.getBranch();
    const slides = branch.filter(e => e.type === 'compaction' || (e.type === 'custom' && e.customType === 'acm-passive' && e.data.cursorId));
    assert.ok(slides.length >= 2, `observed ${slides.length} slides`);
    const compactions = branch.filter(e => e.type === 'compaction');
    assert.equal(compactions.length, 0, 'Native estimates cannot persist a boundary before a healthy Main response');
    for (const e of compactions) { assert.equal(e.summary, MARKER); assert.equal(e.usage, undefined); }
    const raw = branch.find(e => e.type === 'message' && e.message.role === 'toolResult');
    assert.equal(raw.message.content[0].text, 'fixed diagnostic output '.repeat(1300));
    const manager = f.session.sessionManager;
    // New extension runtime, same persisted branch; no hidden singleton state required.
    const resumed = await fixture({ sessionManager: manager, modelRuntime: f.modelRuntime });
    const requests = [];
    const resumedSummary = mockStream(resumed, model => assistant(model, [{ type: 'text', text: 'resumed' }]), requests);
    try {
      await resumed.session.prompt('Continue the exact task; keep the same constraints.');
      assert.equal(requests.length, 1);
      assertPairing(requests[0].messages);
      assert.ok(counter.total(requests[0].messages) <= 217600);
      assert.ok(requests[0].messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('Exact current task')));
      assert.equal(resumedSummary(), 0);
    } finally { await resumed.teardown(); }
  } finally { await f.teardown(); }
});

test('same-request Main usage trains calibration; native footer view and branch restart stay correctly scoped', async () => {
  const statuses = new Map();
  const notices = [];
  const ui = { setStatus: (k, v) => statuses.set(k, v), notify: text => notices.push(text) };
  const f = await fixture({ uiContext: ui });
  const raw = createCounter();
  const requests = [];
  const summaries = mockStream(f, (model, context) => {
    const prompt = Math.ceil((raw.total(context.messages) - 2048) * 1.4);
    return assistant(model, [{ type: 'text', text: 'measured fixture reply' }], {
      ...zeroUsage, input: prompt - 100, cacheRead: 100, output: 50, totalTokens: prompt + 50 });
  }, requests);
  try {
    await f.session.prompt('Bounded same-request calibration sample. '.repeat(4000));
    const samples = () => f.session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'acm-passive-calibration');
    assert.equal(samples().length, 1);
    assert.ok(samples()[0].data.basisTokens >= 8192);
    assert.equal(statuses.get('acm-passive'), `ACM ${f.session.getContextUsage().percent.toFixed(1)}%`);
    await f.session.prompt('A short continuation of this exact fixture.');
    assert.equal(samples().length, 2);
    const ctx = { ui, model: f.model, sessionManager: f.session.sessionManager, getContextUsage: () => f.session.getContextUsage() };
    await f.extensions.extensions[0].commands.get('acm-status').handler('', ctx);
    const detail = JSON.parse(notices.at(-1));
    assert.equal(detail.phase, 'native-Pi-current-context');
    assert.ok(detail.calibration.factor >= 1.47 - 1e-8);
    assert.equal(detail.calibration.samples, 2);
    // A response without an approved stream-start snapshot is not a sample.
    const callback = f.extensions.extensions[0].handlers.get('turn_end')[0];
    await callback({ message: assistant(f.model, [{ type: 'text', text: 'unmatched' }], {
      ...zeroUsage, input: 260000, output: 100, totalTokens: 260100 }), messageEntryId: 'not-a-real-response' }, ctx);
    assert.equal(samples().length, 2);
    const resumed = await fixture({ sessionManager: f.session.sessionManager, modelRuntime: f.modelRuntime, uiContext: ui });
    try {
      await resumed.extensions.extensions[0].commands.get('acm-status').handler('', ctx);
      assert.equal(JSON.parse(notices.at(-1)).calibration.samples, 2);
    } finally { await resumed.teardown(); }
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('a later preview context cannot steal an already-started Main response calibration', async () => {
  const f = await fixture();
  const raw = createCounter();
  let expectedVisible;
  let previewVisible;
  let summaryCalls = 0;
  f.modelRuntime.streamSimple = () => { summaryCalls++; throw new Error('Forbidden summary'); };
  f.session.agent.streamFunction = (model, context) => {
    const stream = ai.createAssistantMessageEventStream();
    expectedVisible = raw.total(context.messages) - 2048;
    const input = Math.ceil(expectedVisible * 1.3);
    const message = assistant(model, [{ type: 'text', text: 'real Main response' }], {
      ...zeroUsage, input, output: 10, totalTokens: input + 10 });
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      setImmediate(async () => {
        try {
          const preview = [...context.messages, { role: 'user', content: 'Preview only; not a request. '.repeat(400), timestamp: Date.now() + 1 }];
          previewVisible = raw.total(preview) - 2048;
          const ctx = { model: f.model, sessionManager: f.session.sessionManager,
            getContextUsage: () => f.session.getContextUsage(), getSystemPrompt: () => '', abort: () => {},
            ui: { setStatus: () => {}, notify: () => {} } };
          await f.extensions.extensions[0].handlers.get('context_with_system')[0]({ messages: preview }, ctx);
          stream.push({ type: 'done', reason: 'stop', message });stream.end();
        } catch (error) { stream.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error', errorMessage: String(error) } });stream.end(); }
      });
    });
    return stream;
  };
  try {
    await f.session.prompt('Same-request binding sample. '.repeat(3000));
    assert.ok(previewVisible > expectedVisible);
    const records = f.session.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'acm-passive-calibration');
    assert.equal(records.length, 1);
    assert.equal(records[0].data.visibleInputTokens, expectedVisible);
    assert.notEqual(records[0].data.visibleInputTokens, previewVisible);
    assert.equal(summaryCalls, 0);
  } finally { await f.teardown(); }
});

test('required opaque replay without generated-output budget aborts before wire, no summary fallback', async () => {
  const manager = core.SessionManager.inMemory('/tmp');
  manager.appendMessage({ ...assistant({ api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' }, [
    { type: 'thinking', thinking: 'summary', thinkingSignature: 'unbudgetable-signature' },
    { type: 'toolCall', id: 'required-opaque-call', name: 'read', arguments: {} }]), usage: zeroUsage });
  manager.appendMessage({ role: 'toolResult', toolCallId: 'required-opaque-call', toolName: 'read', content: [{ type: 'text', text: 'ok' }], timestamp: Date.now() });
  const f = await fixture({ sessionManager: manager });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'must not run' }]), requests);
  try {
    await f.session.prompt('Preserve this most recent exact batch.');
    assert.equal(requests.length, 0);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('manual /compact is canceled through public API, not replaced by a model request', async () => {
  const f = await fixture();
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'ok' }]), requests);
  try {
    await f.session.prompt('Fixture only.');
    await f.session.prompt('Keep original output.');
    // Force native preparation only AFTER valid normal requests; the guard must
    // still cancel this manual path rather than produce a summary.
    f.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0 } });
    await assert.rejects(f.session.compact(), /cancel/i);
    assert.equal(requests.length, 2);
    assert.equal(summaries(), 0);
    assert.equal(f.session.sessionManager.getBranch().filter(e => e.type === 'compaction').length, 0);
  } finally { await f.teardown(); }
});

test('disabled native trigger fails closed in actual agent; no wire request and no summary fallback', async () => {
  const f = await fixture({ enabled: false });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'should not run' }]), requests);
  try {
    await f.session.prompt('This must be blocked before transport.');
    assert.equal(requests.length, 0);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('maximum model and matching per-model reserve run the real Pi loop using mock wire only', async () => {
  const statuses = new Map();
  const ui = { setStatus: (key, value) => statuses.set(key, value), notify: () => {} };
  const f = await fixture({ modelContext: 1050000, uiContext: ui });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'offline maximum fixture' }]), requests);
  try {
    await f.session.prompt('Test maximum local configuration only. No actual provider request.');
    assert.equal(requests.length, 1);
    assert.equal(f.session.getContextUsage().contextWindow, 1050000);
    assert.equal(statuses.get('acm-passive'), `ACM ${f.session.getContextUsage().percent.toFixed(1)}%`);
    assert.equal(summaries(), 0);
    assertPairing(requests[0].messages);
  } finally { await f.teardown(); }
});

test('request-time display stays native even when calibrated estimate differs, unknown stays unknown', async () => {
  const statuses = new Map();
  const notices = [];
  const ui = { setStatus: (key, value) => statuses.set(key, value), notify: text => notices.push(text) };
  const f = await fixture({ uiContext: ui });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'native display fixture' }]), requests);
  try {
    await f.session.prompt('Short deterministic native-display fixture.');
    let native = { tokens: 110976, contextWindow: 272000, percent: 40.8 };
    const ctx = { ui, model: f.model, sessionManager: f.session.sessionManager,
      getContextUsage: () => native, getSystemPrompt: () => 'Fixture system', abort: () => {} };
    const callback = f.extensions.extensions[0].handlers.get('context_with_system')[0];
    await callback({ messages: requests[0].messages }, ctx);
    assert.equal(statuses.get('acm-passive'), 'ACM 40.8%');
    await f.extensions.extensions[0].commands.get('acm-status').handler('', ctx);
    const detail = JSON.parse(notices.at(-1));
    assert.equal(detail.displaySource, 'native-Pi-footer');
    assert.equal(detail.nativePiView.percent, 40.8);
    assert.ok(Math.abs(detail.after / 272000 * 100 - 40.8) > 10, 'Native display never substitutes the background estimate');
    native = { tokens: null, contextWindow: 272000, percent: null };
    await f.extensions.extensions[0].handlers.get('session_compact')[0]({}, ctx);
    assert.equal(statuses.get('acm-passive'), 'ACM ?%');
    assert.equal(requests.length, 1, 'Display does not submit another provider request');
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

function pressureFixture() {
  const manager = core.SessionManager.inMemory('/tmp');
  const model = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' };
  const goal = manager.appendMessage({ role: 'user', content: 'Exact task: preserve recent outputs; no replay.', timestamp: Date.now() });
  let through;
  for (let i = 0; i < 6; i++) through = manager.appendMessage(assistant(model, [{ type: 'text', text: 'closed fixture history '.repeat(13000) }]));
  const start = manager.appendMessage({ role: 'user', content: 'Current uncheckpointed work step.', timestamp: Date.now() });
  const call = manager.appendMessage(assistant(model, [{ type: 'toolCall', id: 'recent-read', name: 'read', arguments: {} }]));
  const text = 'complete recent evidence '.repeat(5000);
  const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'recent-read', toolName: 'read', content: [{ type: 'text', text }], timestamp: Date.now() });
  manager.appendCustomEntry('acm-passive', { anchorIds: [], taskAnchorId: goal, cursorId: null, carriedIds: [],
    worksetInitialized: true, worksetStartId: start, checkpointThroughId: through });
  return { manager, goal, start, call, result, text };
}
const healthyUsage = context => {
  const input = createCounter().total(context.messages);
  return { ...zeroUsage, input, output: 30, totalTokens: input + 30 };
};

test('version1.2 missing or obsolete working-span checkpoints migrate automatically without reviving the cropped prefix', async () => {
  for (const floor of ['missing-old-floor', 'old-prefix']) {
    const seeded = pressureFixture();
    const before = branchState(seeded.manager.getBranch()).state;
    seeded.manager.appendCustomEntry('acm-passive', { ...before, cursorId: seeded.start,
      worksetInitialized: true, worksetStartId: floor, checkpointThroughId: 'missing-old-checkpoint' });
    const rawBefore = JSON.stringify(seeded.manager.getBranch().filter(e => e.type === 'message'));
    const f = await fixture({ sessionManager: seeded.manager, uiContext: { confirm: async () => { throw new Error('No manual confirmations allowed'); } } });
    const requests = [];
    const summaries = mockStream(f, (m, context) => assistant(m, [{ type: 'text', text: 'automatic migration' }], healthyUsage(context)), requests);
    try {
      await f.session.prompt('繼續');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].messages.some(m => JSON.stringify(m.content).includes('closed fixture history')), false);
      assert.equal(requests[0].messages.find(m => m.role === 'toolResult').content[0].text, seeded.text);
      assertPairing(requests[0].messages);
      const after = branchState(seeded.manager.getBranch()).state;
      assert.equal(after.cursorId, seeded.start);
      assert.equal(after.windowMode, 'automatic');
      assert.equal(after.worksetStartId, null);
      assert.equal(after.checkpointThroughId, null);
      assert.equal(summaries(), 0);
      const originalIds = new Set(JSON.parse(rawBefore).map(e => e.id));
      assert.equal(JSON.stringify(seeded.manager.getBranch().filter(e => originalIds.has(e.id))), rawBefore);
    } finally { await f.teardown(); }
  }
});

test('error then ESC-aborted retry then continue preserves complete recent work; only healthy response commits cursor', async () => {
  const seeded = pressureFixture();
  const f = await fixture({ sessionManager: seeded.manager });
  const requests = [];
  const summaries = mockStream(f, (model, context, n) => n < 3 ? { ...assistant(model,
    Array.from({ length: 48 }, () => ({ type: 'thinking', thinking: '', thinkingSignature: 'fixture-opaque-not-decoded' }))),
    stopReason: n === 1 ? 'error' : 'aborted', errorMessage: 'synthetic terminated/ESC', usage: zeroUsage } :
    assistant(model, [{ type: 'text', text: 'healthy continuation' }], healthyUsage(context)), requests);
  try {
    for (const text of ['Continue', 'retry', '繼續']) {
      const before = branchState(seeded.manager.getBranch()).state;
      await f.session.prompt(text);
      const after = branchState(seeded.manager.getBranch()).state;
      if (requests.length < 3) assert.equal(after.cursorId, before.cursorId, 'Failed responses cannot commit a cut');
    }
    assert.equal(requests.length, 3);
    const priorSize = createCounter().total(requests[0].messages);
    for (const request of requests) {
      assert.ok(createCounter().total(request.messages) >= priorSize * 0.95, 'ESC/error cannot turn the accumulated effective window into a tiny retry');
      assertPairing(request.messages);
      assert.ok(request.messages.some(m => m.role === 'user' && m.content === 'Current uncheckpointed work step.'));
      assert.equal(request.messages.find(m => m.role === 'toolResult' && m.toolCallId === 'recent-read').content[0].text, seeded.text);
      assert.equal(request.messages.some(m => m.role === 'assistant' && ['error', 'aborted'].includes(m.stopReason)), false);
    }
    const state = branchState(seeded.manager.getBranch()).state;
    assert.ok(state.cursorId, 'Healthy same-request response commits the validated closed-prefix cut');
    assert.equal(state.windowMode, 'automatic');
    assert.equal(state.worksetStartId, null);
    assert.equal(state.lastGoodBoundary.cursorId, null);
    assert.equal(seeded.manager.getBranch().find(e => e.id === seeded.result).message.content[0].text, seeded.text);
    assert.equal(seeded.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && ['error','aborted'].includes(e.message.stopReason)).length, 2);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('late guard validation failure cannot persist a planned boundary; a clean retry is not fault-latched', async () => {
  const seeded = pressureFixture();
  const f = await fixture({ sessionManager: seeded.manager });
  const requests = [];
  const summaries = mockStream(f, (model, context) => assistant(model, [{ type: 'text', text: 'valid retry' }], healthyUsage(context)), requests);
  const guard = f.extensions.extensions[1];
  const original = guard.handlers.get('context_with_system');
  try {
    guard.handlers.set('context_with_system', [(_event, ctx) => { ctx.abort(); throw new Error('Injected late request verification failure'); }]);
    await f.session.prompt('Continue the unfinished work.');
    assert.equal(requests.length, 0);
    assert.equal(branchState(seeded.manager.getBranch()).state.cursorId, null);
    guard.handlers.set('context_with_system', original);
    await f.session.prompt('繼續');
    assert.equal(requests.length, 1);
    assert.ok(branchState(seeded.manager.getBranch()).state.cursorId);
    assert.equal(summaries(), 0);
  } finally { guard.handlers.set('context_with_system', original); await f.teardown(); }
});

test('a physically oversized essential user message still aborts rather than sending incomplete instructions', async () => {
  const f = await fixture();
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'must not run' }]), requests);
  try {
    await f.session.prompt('uncheckpointed critical output '.repeat(65000));
    const first = branchState(f.session.sessionManager.getBranch()).state;
    assert.equal(first.windowMode, 'automatic');
    assert.equal(first.cursorId, null);
    await f.session.prompt('繼續');
    const next = branchState(f.session.sessionManager.getBranch()).state;
    assert.equal(next.taskAnchorId, first.taskAnchorId);
    assert.equal(next.cursorId, null);
    assert.equal(requests.length, 0);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('native threshold and overflow cannot force an under-budget crop or reset the working span', async () => {
  const f = await fixture();
  const requests = [];
  const summaries = mockStream(f, (model, context) => assistant(model, [{ type: 'text', text: 'normal reply' }], healthyUsage(context)), requests);
  try {
    await f.session.prompt('Preserve this ongoing step.');
    const before = JSON.stringify(branchState(f.session.sessionManager.getBranch()).state);
    for (const reason of ['threshold', 'overflow']) assert.deepEqual(await f.extensions.extensions[0].handlers.get('session_before_compact')[0]({ reason },
      { ui: { notify: () => {} } }), { cancel: true });
    assert.equal(JSON.stringify(branchState(f.session.sessionManager.getBranch()).state), before);
    assert.equal(requests.length, 1);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('config display is read-only, needs no confirmation and makes no model request', async () => {
  const notices = [];
  const f = await fixture({ fileSettings: true, uiContext: { notify: text => notices.push(text), confirm: async () => { throw new Error('No confirmations'); } } });
  const requests = [];
  const summaries = mockStream(f, model => assistant(model, [{ type: 'text', text: 'must not run' }]), requests);
  try {
    const file = await readFile(join(f.temp, 'settings.json'), 'utf8');
    const branch = JSON.stringify(f.session.sessionManager.getBranch());
    await f.configCommand('/acm-config');
    assert.match(notices.at(-1), /80％.*70％/);
    assert.match(notices.at(-1), /acm-config reset/);
    assert.equal(await readFile(join(f.temp, 'settings.json'), 'utf8'), file);
    assert.equal(JSON.stringify(f.session.sessionManager.getBranch()), branch);
    assert.equal(requests.length, 0);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('historical carried rows and newer tail survive native compaction and reload without a restore command', async () => {
  const manager = core.SessionManager.inMemory('/tmp');
  const model = { api: 'openai-codex-responses', provider: 'openai-codex', id: 'gpt-6.1-sol' };
  const old = manager.appendMessage({ role: 'user', content: 'Previously retained step.', timestamp: Date.now() });
  const call = manager.appendMessage(assistant(model, [{ type: 'toolCall', id: 'legacy-read', name: 'read', arguments: {} }]));
  const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'legacy-read', toolName: 'read', content: [{ type: 'text', text: 'older verified result' }], timestamp: Date.now() });
  const tail = manager.appendMessage({ role: 'user', content: 'NEW TAIL MUST SURVIVE.', timestamp: Date.now() });
  manager.appendCompaction(MARKER, tail, 100, { acmPassive: { version: 1, carriedIds: [] } });
  manager.appendCustomEntry('acm-passive', { cursorId: old, carriedIds: [old, call, result], anchorIds: [old], windowMode: 'automatic' });
  const f = await fixture({ sessionManager: manager });
  try {
    assert.equal(f.extensions.extensions[0].commands.has('acm-restore'), false);
    const resumed = await fixture({ sessionManager: manager, modelRuntime: f.modelRuntime });
    const next = [];
    const summaries = mockStream(resumed, (m, context) => assistant(m, [{ type: 'text', text: 'continued' }], healthyUsage(context)), next);
    try {
      await resumed.session.prompt('繼續');
      assert.equal(next.length, 1);
      assert.ok(next[0].messages.some(m => m.role === 'user' && m.content === 'NEW TAIL MUST SURVIVE.'));
      assert.equal(next[0].messages.find(m => m.role === 'toolResult' && m.toolCallId === 'legacy-read').content[0].text, 'older verified result');
      assertPairing(next[0].messages);
      assert.equal(manager.getBranch().filter(e => e.id === result).length, 1);
      assert.equal(summaries(), 0);
    } finally { await resumed.teardown(); }
  } finally { await f.teardown(); }
});

test('public session.abort ESC path cannot commit a pending cut and preserves complete work on retry', async () => {
  const seeded = pressureFixture();
  const f = await fixture({ sessionManager: seeded.manager });
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let requests = 0;
  let summaries = 0;
  f.modelRuntime.streamSimple = () => { summaries++; throw new Error('Forbidden summary'); };
  f.session.agent.streamFunction = (model, _context, options) => {
    requests++;
    const stream = ai.createAssistantMessageEventStream();
    const partial = assistant(model, [{ type: 'thinking', thinking: '', thinkingSignature: 'synthetic-ESC-opaque' }]);
    options.signal.addEventListener('abort', () => {
      stream.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted' } }); stream.end();
    }, { once: true });
    queueMicrotask(() => { stream.push({ type: 'start', partial }); started(); });
    return stream;
  };
  try {
    const run = f.session.prompt('Continue, then deliberately interrupt this offline fixture.');
    await ready;
    await f.session.abort();
    await run;
    assert.equal(requests, 1);
    assert.equal(branchState(seeded.manager.getBranch()).state.cursorId, null);
    const captured = [];
    const retrySummaries = mockStream(f, (m, context) => assistant(m, [{ type: 'text', text: 'after actual abort' }], healthyUsage(context)), captured);
    await f.session.prompt('繼續');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].messages.find(m => m.role === 'toolResult' && m.toolCallId === 'recent-read').content[0].text, seeded.text);
    assert.equal(branchState(seeded.manager.getBranch()).state.windowMode, 'automatic');
    assert.equal(branchState(seeded.manager.getBranch()).state.worksetStartId, null);
    assert.equal(summaries + retrySummaries(), 0);
  } finally { await f.teardown(); }
});

test('invalid percentages, busy session and pending messages cannot change settings, branch or request a model', async () => {
  const notices = [];
  const f = await fixture({ fileSettings: true, uiContext: { notify: text => notices.push(text) } });
  const captured = [];
  const summaries = mockStream(f, m => assistant(m, [{ type: 'text', text: 'must not run' }]), captured);
  try {
    const file = await readFile(join(f.temp, 'settings.json'), 'utf8');
    const branch = JSON.stringify(f.session.sessionManager.getBranch());
    for (const args of ['80', '80 80', '70 80', '100 70', '80 0', '-1 70', 'NaN 70', 'Infinity 70', '0x50 70', '80 70 extra']) {
      await f.configCommand('/acm-config ' + args);
      assert.equal(await readFile(join(f.temp, 'settings.json'), 'utf8'), file);
    }
    const command = f.extensions.extensions[0].commands.get('acm-config');
    for (const [idle, pending] of [[false, false], [true, true]]) {
      await command.handler('85 75', { ui: { notify: text => notices.push(text) }, isIdle: () => idle, hasPendingMessages: () => pending });
      assert.match(notices.at(-1), /佇列清空/);
    }
    assert.equal(JSON.stringify(f.session.sessionManager.getBranch()), branch);
    assert.equal(captured.length, 0);
    assert.equal(summaries(), 0);
  } finally { await f.teardown(); }
});

test('config persists ratios, synchronizes native settings and both extensions through real reload, without cutting history', async () => {
  const seeded = pressureFixture();
  const notices = [];
  const f = await fixture({ sessionManager: seeded.manager, fileSettings: true, uiContext: { notify: text => notices.push(text) } });
  const captured = [];
  const summaries = mockStream(f, (m, context) => assistant(m, [{ type: 'text', text: 'healthy window' }], healthyUsage(context)), captured);
  try {
    const state = JSON.stringify(branchState(seeded.manager.getBranch()).state);
    const raw = JSON.stringify(seeded.manager.getBranch());
    await f.configCommand('/acm-config 85 75');
    assert.deepEqual(f.settingsManager.getSettings().acm, { triggerPercent: 85, targetPercent: 75 });
    const saved = JSON.parse(await readFile(join(f.temp, 'settings.json'), 'utf8'));
    assert.equal(saved.compaction.reserveTokens, 40800);
    assert.equal(saved.compaction.keepRecentTokens, 204000);
    assert.deepEqual(saved.compaction.modelOverrides['openai-codex/gpt-6.1-sol'], { reserveTokens: 40800, keepRecentTokens: 204000 });
    assert.deepEqual(core.SettingsManager.create(f.temp, f.temp).getSettings().acm, saved.acm, 'fresh manager reads the persisted percentages');
    assert.equal(JSON.stringify(branchState(seeded.manager.getBranch()).state), state);
    assert.equal(JSON.stringify(seeded.manager.getBranch()), raw, 'changing config cannot append a boundary, restore or rewrite raw entries');
    assert.equal(captured.length, 0);
    await f.configCommand('/acm-status');
    const status = JSON.parse(notices.at(-1));
    assert.equal(status.version, '1.4.2');
    assert.equal(status.policy.triggerRatio, 0.85);
    assert.equal(status.policy.targetRatio, 0.75);
    assert.equal(f.extensions.extensions.length, 2);
    await f.session.prompt('Continue the protected step.');
    assert.equal(captured.length, 1);
    assertPairing(captured[0].messages);
    const beforeReset = JSON.stringify(branchState(seeded.manager.getBranch()).state);
    await f.configCommand('/acm-config reset');
    assert.deepEqual(f.settingsManager.getSettings().acm, { triggerPercent: 95, targetPercent: 85 });
    assert.equal(f.settingsManager.getCompactionSettings(f.model).reserveTokens, 13600);
    assert.equal(f.settingsManager.getCompactionSettings(f.model).keepRecentTokens, 231200);
    assert.equal(JSON.stringify(branchState(seeded.manager.getBranch()).state), beforeReset);
    assert.equal(captured.length, 1);
    assert.equal(summaries(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.teardown(); }
});

test('lowering ratios defers sliding until the next healthy request and preserves raw history', async () => {
  const seeded = pressureFixture();
  const f = await fixture({ fileSettings: true, sessionManager: seeded.manager });
  const captured = [];
  const summaries = mockStream(f, (m, context) => assistant(m, [{ type: 'text', text: 'lower threshold continuation' }], healthyUsage(context)), captured);
  try {
    const raw = JSON.stringify(seeded.manager.getBranch());
    await f.configCommand('/acm-config 75 65');
    assert.equal(JSON.stringify(seeded.manager.getBranch()), raw);
    assert.equal(captured.length, 0);
    assert.equal(f.settingsManager.getCompactionSettings(f.model).reserveTokens, 68000);
    assert.equal(f.settingsManager.getCompactionSettings(f.model).keepRecentTokens, 176800);
    await f.session.prompt('Continue, keeping the full recent batch.');
    assert.equal(captured.length, 1);
    assertPairing(captured[0].messages);
    assert.ok(createCounter().total(captured[0].messages) <= 204000);
    assert.equal(captured[0].messages.find(m => m.role === 'toolResult' && m.toolCallId === 'recent-read').content[0].text, seeded.text);
    assert.ok(branchState(seeded.manager.getBranch()).state.cursorId);
    assert.equal(seeded.manager.getBranch().find(e => e.id === seeded.result).message.content[0].text, seeded.text);
    assert.equal(summaries(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.teardown(); }
});

test('reload failure rolls back the original settings without changing history or making model requests', async () => {
  const f = await fixture({ fileSettings: true });
  const captured = [];
  const summaries = mockStream(f, m => assistant(m, [{ type: 'text', text: 'must not run' }]), captured);
  try {
    const file = await readFile(join(f.temp, 'settings.json'), 'utf8');
    const raw = JSON.stringify(f.session.sessionManager.getBranch());
    await f.session.bindExtensions({ commandContextActions: { waitForIdle: async () => {}, reload: async () => { throw new Error('Injected reload failure'); } } });
    await f.configCommand('/acm-config 85 75');
    assert.equal(await readFile(join(f.temp, 'settings.json'), 'utf8'), file);
    assert.deepEqual(f.settingsManager.getSettings().acm, JSON.parse(file).acm);
    assert.equal(JSON.stringify(f.session.sessionManager.getBranch()), raw);
    assert.equal(captured.length, 0);
    assert.equal(summaries(), 0);
    assert.ok(f.errors.some(error => /原設定已復原/.test(String(error.error))));
  } finally { await f.teardown(); }
});
