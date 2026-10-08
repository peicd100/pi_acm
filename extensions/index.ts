import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { buildSessionProjection, sessionEntryToContextMessages, getAgentDir } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { MARKER, validatePolicy, createCounter, previewMessage, messageKey,
  selectWindow, branchState, applyLegacyRows, applyCursor, assertPairing, atomicGroups, omitFailedAttempts } from '../src/window.mjs';
import { CALIBRATION_TYPE, createCalibration, modelKey } from '../src/calibration.mjs';
import { CONFIG_USAGE, parseConfigCommand, policyForSettings, nativeBudget, assertNativeSettings,
  commitConfig, rollbackConfig } from '../src/config.mjs';

export default function passiveWindow(pi: ExtensionAPI) {
  // Invalid policy prevents this extension loading; config/resource smoke is required before activation.
  const basePolicy = validatePolicy(JSON.parse(readFileSync(fileURLToPath(new URL('../policy.json', import.meta.url)), 'utf8')));
  let policy = basePolicy;
  const refreshPolicy = () => { policy = validatePolicy(policyForSettings(basePolicy, pi.getSettings())); return policy; };
  const counter = createCounter(basePolicy);
  let fault: string | undefined;
  let last: any = { version: '1.4.0', windowMode: 'automatic', manualCheckpointRequired: false,
    before: 0, after: 0, slides: 0, phase: 'startup' };
  let displayedNative: string | undefined;
  const renderNativeStatus = (ctx: ExtensionContext) => {
    const native = ctx.getContextUsage();
    const percent = native?.percent;
    // Exact same source and precision as Pi's footer; never display a projected
    // request-budget percentage as if it were the native current-context view.
    const text = typeof percent === 'number' && Number.isFinite(percent)
      ? `ACM ${percent.toFixed(1)}%` : 'ACM ?%';
    last = { ...last, nativePiView: native, displaySource: 'native-Pi-footer' };
    if (text !== displayedNative) {
      ctx.ui.setStatus('acm-passive', text);
      displayedNative = text;
    }
  };
  const calibration = createCalibration();
  let pending: any;
  const inFlight = new Map<string, any>();
  const responseKey = (m: any) => JSON.stringify([m.provider, m.api, m.model, m.timestamp]);
  const calibrated = (ctx: ExtensionContext, branch = ctx.sessionManager.getBranch()) => {
    calibration.restore(branch);
    return calibration.view(modelKey(ctx.model), counter, policy);
  };

  const fail = (ctx: ExtensionContext, error: unknown) => {
    const text = error instanceof Error ? error.message : String(error);
    fault = text;
    pending = undefined;
    // Pi catches ordinary handler exceptions; abort the run explicitly BEFORE returning/throwing.
    try { ctx.abort(); } catch { /* the independent no-summary guard still cancels compaction */ }
    try { ctx.ui.notify(`ACM sliding window blocked: ${text}. No summary fallback.`, 'error'); } catch { /* non-UI mode */ }
  };
  const configCheck = (ctx: ExtensionContext) => {
    if (pi.getAllTools().some(t => t.name.startsWith('acm_'))) throw new Error('Legacy/model-callable ACM tools are still loaded');
    refreshPolicy();
    return assertNativeSettings(pi.getSettings(), ctx.model, policy);
  };

  const boundaryKey = (s: any) => JSON.stringify([s.cursorId, s.carriedIds, s.anchorIds,
    s.taskAnchorId, s.windowMode]);

  function sourceRows(branch: any[], override?: any) {
    const { legacy, state: stored } = branchState(branch);
    const state = override ?? stored;
    let rows = buildSessionProjection(branch).entries.flatMap(e => e.messages
      .filter(m => m.role !== 'system' && !(m.role === 'compactionSummary' && m.summary === MARKER))
      .map(message => ({ id: e.sourceEntry.id, message })));
    rows = applyLegacyRows(rows, legacy);
    const protectedIds = [...state.anchorIds, ...(state.taskAnchorId ? [state.taskAnchorId] : []),
      ...Object.keys(legacy.pinned ?? {}).filter(id => legacy.pinned[id])];
    const carry = new Set([...protectedIds, ...state.carriedIds]);
    // Version 1.2 working-span/checkpoint metadata is historical only. Do not
    // resurrect its old prefix or make an entire multi-day task mandatory.
    const retained = new Set(carry);
    const present = new Set(rows.map(r => r.id));
    const edits = new Map(branch.filter(e => e.type === 'context_edit').map(e => [e.targetId, e.replacement]));
    for (const e of branch) if (carry.has(e.id) && !present.has(e.id) && !legacy.pruned?.[e.id]) {
      if (edits.has(e.id) && edits.get(e.id) === null) continue;
      for (let message of sessionEntryToContextMessages(e)) {
        if (message.role === 'system' || message.role === 'compactionSummary') continue;
        const replacement: any = edits.get(e.id);
        if (replacement) message = { ...message, content: typeof replacement.content === 'string' &&
          ['assistant', 'toolResult'].includes(message.role) ? [{ type: 'text', text: replacement.content }] : replacement.content } as any;
        rows.push({ id: e.id, message });
      }
    }
    const rank = new Map(branch.map((e, i) => [e.id, i]));
    rows.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
    rows = applyCursor(rows, { ...state, carriedIds: [...retained] }, branch);
    return { rows, state, protectedIds, carriedIds: [...retained] };
  }

  function normalize(rows: any[], ctx: ExtensionContext, protectedIds: string[] = []) {
    const path = ctx.sessionManager.getSessionFile();
    const clean = omitFailedAttempts(rows);
    const groups = atomicGroups(clean);
    const full = new Set(protectedIds);
    const latestBatch = groups.findLast(g => g.rows.some(r => r.message.role === 'assistant' &&
      r.message.content?.some?.((b: any) => b.type === 'toolCall')));
    for (const r of latestBatch?.rows ?? []) full.add(r.id);
    // ESC/error does not change the latest completed batch. Its full results
    // remain byte-for-byte in retry input; only older optional text is previewed.
    return clean.map(r => ({ ...r, message: full.has(r.id) ? r.message :
      previewMessage(r.message, policy, path ? JSON.stringify(path) : 'the raw in-memory session') }));
  }

  pi.on('session_start', (event, ctx) => {
    fault = undefined;
    last = { version: '1.4.0', windowMode: 'automatic', manualCheckpointRequired: false,
      before: 0, after: 0, slides: 0, phase: 'startup' };
    try {
      refreshPolicy();
      const percentages = (pi.getSettings() as any).acm ?? { triggerPercent: 80, targetPercent: 70 };
      if (event.reason === 'reload') ctx.ui.notify(`ACM 1.4：觸發 ${percentages.triggerPercent}％／保留目標 ${percentages.targetPercent}％ 已載入；窗口邊界未變更。`, 'info');
    } catch (error) { fail(ctx, error); }
    pending = undefined;
    inFlight.clear();
    calibration.restore(ctx.sessionManager.getBranch());
    ctx.ui.setStatus('acm', undefined);
    displayedNative = undefined;
    renderNativeStatus(ctx);
  });
  // Commands only, never registered as model tools. Latest user and latest complete tool batch are automatic anchors.
  pi.registerCommand('acm-status', {
    description: 'Show bounded token-window status (UI only; no model request)',
    handler: async (_args, ctx) => {
      try { refreshPolicy(); } catch (error) { fault = error instanceof Error ? error.message : String(error); }
      renderNativeStatus(ctx);
      ctx.ui.notify(JSON.stringify({ ...last, fault, policy, config: (pi.getSettings() as any).acm ?? { triggerPercent: 80, targetPercent: 70 }, counter: counter.stats(),
        calibration: calibrated(ctx).describe(), nativePiView: ctx.getContextUsage(),
        boundary: branchState(ctx.sessionManager.getBranch()).state }, null, 2), 'info');
    },
  });
  pi.registerCommand('acm-config', {
    description: '查看或永久設定觸發／保留比例：/acm-config [80 70|reset]（不呼叫模型）',
    handler: async (args, ctx) => {
      let receipt: any;
      try {
        const percentages = parseConfigCommand(args);
        if (!percentages) {
          refreshPolicy();
          const b = ctx.model ? nativeBudget(ctx.model, policy) : null;
          const current = (pi.getSettings() as any).acm ?? { triggerPercent: 80, targetPercent: 70 };
          ctx.ui.notify(`ACM：觸發 ${current.triggerPercent}％／保留目標 ${current.targetPercent}％\n${CONFIG_USAGE}\n` +
            (b ? `目前模型 ${ctx.model!.provider}/${ctx.model!.id}：門檻 ${b.trigger}、目標 ${b.target} tokens。\n` : '') +
            '修改只限閒置 session；儲存後自動 reload，不立刻滑窗、不恢復舊訊息。', 'info');
          return;
        }
        const idle = () => {
          if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('請等模型／工具完成且訊息佇列清空後再修改比例；未變更設定。');
        };
        idle();
        await ctx.waitForIdle();
        idle();
        receipt = commitConfig({ path: join(getAgentDir(), 'settings.json'), cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(), runtimeSettings: pi.getSettings(),
          model: ctx.model, base: basePolicy, percentages });
        if (receipt.lockCleanupWarning) ctx.ui.notify(receipt.lockCleanupWarning, 'warning');
        if (percentages.triggerPercent - percentages.targetPercent < 5) {
          ctx.ui.notify('ACM：比例差距小於 5 個百分點，可能頻繁滑窗；建議差距 5–10。', 'warning');
        }
        ctx.ui.notify('ACM：比例與目前模型 compaction 設定已一起儲存，正在重新載入閒置 session。', 'info');
      } catch (error) {
        if (receipt) rollbackConfig(receipt);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      try {
        await ctx.reload();
        // The old pi/ctx/runtime is now invalid. No post-reload access or message request.
      } catch (error) {
        try { rollbackConfig(receipt); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'ACM reload 失敗，且設定檔已有異動或無法回退；請檢查設定後在閒置時 /reload。');
        }
        throw new Error('ACM reload 失敗，原設定已復原；請在閒置時 /reload 後再試。', { cause: error });
      }
    },
  });

  // Native threshold/overflow estimates are hints, not permission to discard work.
  // The SAME request-local selector below owns the window. Its durable cursor is
  // committed only after a healthy, matched Main response, never before transport.
  // Cancel every native/manual summarization path, including failed recovery.
  pi.on('session_before_compact', (event, ctx) => {
    if (event.reason === 'manual') ctx.ui.notify('AI compaction is disabled; original history is preserved.', 'info');
    return { cancel: true };
  });

  // Same selector, NOT an independent priority/pressure pruning system.
  // Covers estimator drift, new user input, and multi-tool batches before every main request.
  pi.on('context_with_system', (event, ctx) => {
    try {
      const b = configCheck(ctx);
      const system = getCurrentSystemMessage(event.messages);
      if (!system) throw new Error('Leading system prompt/tool declarations missing');
      const branch = ctx.sessionManager.getBranch();
      const { rows: sources, state, protectedIds, carriedIds } = sourceRows(branch);
      const byKey = new Map(sources.map(r => [messageKey(r.message), r]));
      const canonicalKeys = new Set(buildSessionProjection(branch).messages.map(messageKey));
      const transport = event.messages.filter(m => m.role !== 'system' && !(m.role === 'compactionSummary' && m.summary === MARKER));
      // Only the authoritative projected/current cursor span is sent. Preserve request-local changes to known rows.
      let rows = transport.flatMap((message, i) => {
        const key = messageKey(message);
        const source = byKey.get(key);
        if (source) return [{ id: source.id, message }];
        // Older canonical rows excluded by the durable guard cursor must not revive.
        const known = canonicalKeys.has(key);
        if (known) return [];
        return [{ id: `request-local:${i}`, message }];
      });
      const present = new Set(rows.map(r => r.id));
      const carried = sources.filter(r => !present.has(r.id) && carriedIds.includes(r.id));
      rows = omitFailedAttempts([...carried, ...rows]);
      atomicGroups(rows);
      const taskAnchorId = state.taskAnchorId ?? rows.findLast(r => r.message.role === 'user')?.id ?? null;
      const nextState = { ...state, taskAnchorId, windowMode: 'automatic',
        worksetInitialized: false, worksetStartId: null, checkpointThroughId: null };
      // Migrate old mandatory-span metadata without moving the saved cursor.
      // Normal task duration, retry, ESC and continue require no manual release.
      if (state.windowMode !== 'automatic' || state.taskAnchorId !== taskAnchorId) pi.appendEntry('acm-passive', nextState);
      rows = normalize(rows, ctx, [...protectedIds, ...(taskAnchorId ? [taskAnchorId] : [])]);
      const budget = calibrated(ctx, branch);
      const fixed = budget.offset + budget.tokens(system) + budget.tokens({ role: 'compactionSummary', summary: MARKER });
      const plan = selectWindow(rows, budget, ctx.model!.contextWindow, policy,
        [...protectedIds, ...(taskAnchorId ? [taskAnchorId] : [])], fixed);
      if (plan.changed && (plan.firstKeptId.startsWith('request-local:') || plan.carriedIds.some(id => id.startsWith('request-local:')))) {
        throw new Error('Cannot persist provenance for request-local sliding boundary');
      }
      const messages: any[] = [system];
      if (state.cursorId || plan.changed) messages.push({ role: 'compactionSummary', summary: MARKER, tokensBefore: plan.before, timestamp: Date.now() });
      messages.push(...plan.rows.map(r => r.message));
      assertPairing(messages);
      const after = budget.total(messages);
      if (!Number.isSafeInteger(after) || after > b.trigger) throw new Error(`Calibrated input budget check failed: ${after} > ${b.trigger}`);
      const candidate = plan.changed ? { ...nextState, taskAnchorId, cursorId: plan.firstKeptId,
        carriedIds: plan.carriedIds, lastGoodBoundary: { cursorId: state.cursorId,
          carriedIds: [...state.carriedIds], anchorIds: [...state.anchorIds], taskAnchorId: state.taskAnchorId } } : null;
      pending = { requestId: randomUUID(), modelKey: modelKey(ctx.model),
        inputFingerprint: createHash('sha256').update(JSON.stringify(messages.map(messageKey))).digest('hex'),
        visibleInputTokens: counter.total(messages) - policy.requestMargin, basisTokens: budget.basis(messages),
        baseBoundary: boundaryKey(nextState), candidate };
      fault = undefined;
      last = { ...last, before: plan.before, after, phase: 'calibrated-next-request',
        windowMode: 'automatic', manualCheckpointRequired: false,
        rawVisibleInputTokens: pending.visibleInputTokens, opaqueBudgetBasisTokens: pending.basisTokens,
        calibration: budget.describe() };
      renderNativeStatus(ctx);
      pi.events.emit('acm-passive:request-ready', { messages, estimatedTokens: after });
      return { messages };
    } catch (error) {
      fail(ctx, error);
      throw error;
    }
  });
  // Bind the approved context to the Main assistant at stream start. A later
  // preview/warming request cannot steal this response's calibration snapshot.
  pi.on('message_start', (event, ctx) => {
    const m: any = event.message;
    if (m.role !== 'assistant') return;
    if (pending?.modelKey === modelKey(ctx.model) &&
      modelKey({ provider: m.provider, api: m.api, id: m.model }) === pending.modelKey) {
      if (!inFlight.has(responseKey(m))) inFlight.set(responseKey(m), pending);
    }
    pending = undefined;
  });
  pi.on('turn_end', (event, ctx) => {
    try {
      const m: any = event.message;
      const key = responseKey(m);
      const snapshot = inFlight.get(key);
      inFlight.delete(key);
      const record = calibration.observe(snapshot, m, modelKey(ctx.model), event.messageEntryId);
      if (record) pi.appendEntry(CALIBRATION_TYPE, record);
      if (record && snapshot?.candidate && ['stop', 'toolUse'].includes(m.stopReason)) {
        const current = branchState(ctx.sessionManager.getBranch()).state;
        if (boundaryKey(current) === snapshot.baseBoundary) {
          assertPairing(sourceRows(ctx.sessionManager.getBranch(), snapshot.candidate).rows.map(r => r.message));
          pi.appendEntry('acm-passive', snapshot.candidate);
          last.slides++;
        } else ctx.ui.notify('ACM：工作邊界已變更，保留目前上下文，未提交過期裁切候選。', 'warning');
      }
      // Calibration still owns the background next-request safety budget.
      // The visible percentage always comes from Pi, including unknown after a slide.
      last = { ...last, phase: 'native-Pi-current-context',
        matchedCalibrationRequest: record?.requestId ?? null };
      renderNativeStatus(ctx);
    } catch (error) { fail(ctx, error); }
  });
  // Refresh only on persisted/lifecycle boundaries, not every streamed token:
  // getContextUsage reads the persisted projection, just as the native footer does.
  for (const event of ['turn_start', 'message_end', 'tool_execution_end', 'agent_end',
    'session_compact', 'session_tree', 'model_select'] as const) {
    pi.on(event, (_event, ctx) => { renderNativeStatus(ctx); });
  }
  pi.on('session_before_tree', event => {
    // Explicit tree summaries must not silently invoke an LLM either. Plain navigation is unchanged.
    if (event.preparation.userWantsSummary) return { cancel: true };
  });
  pi.on('session_shutdown', (_event, ctx) => ctx.ui.setStatus('acm-passive', undefined));
}
