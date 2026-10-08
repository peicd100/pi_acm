// Local budgeting only. Never decode/rewrite provider signatures or request an LLM.
const SAFE_MARGIN = 1.05;
const RATIO_MIN_BASIS = 8192;
const integer = n => Number.isSafeInteger(n) && n >= 0;
export const CALIBRATION_TYPE = 'acm-passive-calibration';
export const modelKey = model => JSON.stringify([model?.provider, model?.api, model?.id]);

export function promptTokens(usage) {
  if (!usage || !['input', 'cacheRead', 'cacheWrite'].every(k => usage[k] === undefined || integer(usage[k]))) return null;
  const n = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return integer(n) && n > 0 ? n : null;
}
export function nativeUsageTokens(usage) {
  if (integer(usage?.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const input = promptTokens(usage);
  return input !== null && integer(usage?.output) ? input + usage.output : null;
}
export function opaqueBasis(message, baseCounter) {
  const visible = baseCounter.tokens(message);
  const opaque = message.role === 'assistant' && message.content?.some?.(b =>
    b.type === 'thinking' && typeof b.thinkingSignature === 'string' && b.thinkingSignature.length > 0);
  if (!opaque) return visible;
  // Original generated output includes hidden reasoning. Do not double-count its
  // visible part. This is a conservative basis, not decrypted/tokenized ciphertext.
  const output = message.usage?.output;
  return integer(output) && output > 0 ? Math.max(visible, output) : Infinity;
}
function validateRecord(record) {
  const keys = ['version', 'requestId', 'responseEntryId', 'modelKey', 'inputFingerprint', 'visibleInputTokens', 'basisTokens', 'actualPromptTokens'];
  if (!record || Object.keys(record).sort().join() !== keys.sort().join() || record.version !== 1 ||
    typeof record.requestId !== 'string' || !record.requestId || typeof record.responseEntryId !== 'string' || !record.responseEntryId ||
    typeof record.modelKey !== 'string' || !record.modelKey ||
    !/^[a-f0-9]{64}$/.test(record.inputFingerprint ?? '') ||
    !['visibleInputTokens', 'basisTokens', 'actualPromptTokens'].every(k => integer(record[k]) && record[k] > 0) ||
    record.basisTokens < record.visibleInputTokens) throw new Error('Invalid branch-local ACM calibration record');
  return record;
}
export function createCalibration() {
  let states = new Map();
  const stateFor = key => states.get(key) ?? { factor: SAFE_MARGIN, offset: 0, samples: 0 };
  function ingest(record) {
    validateRecord(record);
    const state = { ...stateFor(record.modelKey) };
    // Small prompts are dominated by fixed wire overhead: do not magnify that
    // small-sample ratio over a future 200k-token window.
    if (record.basisTokens < RATIO_MIN_BASIS) {
      state.offset = Math.max(state.offset, Math.ceil(Math.max(0, record.actualPromptTokens - record.basisTokens) * SAFE_MARGIN));
    } else {
      state.factor = Math.max(state.factor, record.actualPromptTokens / record.basisTokens * SAFE_MARGIN);
    }
    state.samples++;
    states.set(record.modelKey, state);
  }
  return {
    restore(branch) {
      states = new Map();
      const byId = new Map(branch.map(entry => [entry.id, entry]));
      for (const entry of branch) if (entry.type === 'custom' && entry.customType === CALIBRATION_TYPE) {
        const record = validateRecord(entry.data);
        const response = byId.get(record.responseEntryId)?.message;
        if (!response || response.role !== 'assistant' || ['error', 'aborted'].includes(response.stopReason) ||
          modelKey({ provider: response.provider, api: response.api, id: response.model }) !== record.modelKey ||
          promptTokens(response.usage) !== record.actualPromptTokens) throw new Error('ACM calibration response binding missing/mismatched');
        ingest(record);
      }
    },
    observe(snapshot, message, currentKey, responseEntryId) {
      if (!snapshot || snapshot.modelKey !== currentKey || message.role !== 'assistant' ||
        ['error', 'aborted'].includes(message.stopReason) ||
        modelKey({ provider: message.provider, api: message.api, id: message.model }) !== currentKey) return null;
      const actual = promptTokens(message.usage);
      if (actual === null) return null;
      const record = validateRecord({ version: 1, requestId: snapshot.requestId, responseEntryId, modelKey: currentKey,
        inputFingerprint: snapshot.inputFingerprint, visibleInputTokens: snapshot.visibleInputTokens,
        basisTokens: snapshot.basisTokens, actualPromptTokens: actual });
      ingest(record);
      return record;
    },
    view(key, baseCounter, policy) {
      const state = { ...stateFor(key) };
      const tokens = message => Math.ceil(opaqueBasis(message, baseCounter) * state.factor);
      const basis = messages => messages.reduce((n, m) => n + opaqueBasis(m, baseCounter), 0);
      return { ...state, tokens, basis,
        total: messages => policy.requestMargin + state.offset + messages.reduce((n, m) => n + tokens(m), 0),
        describe: () => ({ ...state, safetyMargin: SAFE_MARGIN, ratioMinimumBasis: RATIO_MIN_BASIS,
          source: state.samples ? 'same-request Main usage; active-branch/model scoped' : 'untrained conservative visible+opaque-output basis',
          guaranteedExactProviderTokens: false }) };
    },
  };
}
