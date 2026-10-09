import { createHash } from 'node:crypto';
import { countTokens, encode, decode } from 'gpt-tokenizer';

export const MARKER = '[ACM token window moved. No AI summary was generated. Original messages remain in the session file.]';
export const DEFAULT_POLICY = Object.freeze({ version: 1, contextCap: 272000, triggerRatio: 0.95,
  targetRatio: 0.85, toolTextTokens: 4096, imageTokens: 4096, requestMargin: 2048,
  cacheEntries: 4096, maxAnchors: 32, noSummary: true });

export function validatePolicy(p) {
  for (const k of ['contextCap', 'toolTextTokens', 'imageTokens', 'requestMargin', 'cacheEntries', 'maxAnchors']) {
    if (!Number.isSafeInteger(p[k]) || p[k] <= 0) throw new Error(`Invalid policy.${k}`);
  }
  if (p.version !== 1 || p.noSummary !== true || !(0 < p.targetRatio && p.targetRatio < p.triggerRatio && p.triggerRatio < 1)) {
    throw new Error('Invalid token-window policy (summarization must remain disabled)');
  }
  return p;
}

export function budgets(contextWindow, policy = DEFAULT_POLICY) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error('Unknown context window');
  const capacity = Math.min(contextWindow, policy.contextCap);
  return { capacity, trigger: Math.floor(capacity * policy.triggerRatio),
    target: Math.floor(capacity * policy.targetRatio), reserve: capacity - Math.floor(capacity * policy.triggerRatio) };
}

// Metadata, usage, tool details and base64 are not tokenized as model text.
// Opaque provider signatures are preserved, not decoded or rewritten.
// Bound BPE work: a huge unbroken CJK/base64-like text must not freeze the hook.
// Chunk boundaries add a conservative allowance; these are estimates, not provider telemetry.
function chunks(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + 2048, text.length);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    out.push(text.slice(i, end)); i = end;
  }
  return out;
}
export function countText(text, limit = Infinity) {
  let n = 0;
  for (const chunk of chunks(text)) {
    n += countTokens(chunk, { allowedSpecial: 'all' }) + 2;
    if (n > limit) return n;
  }
  return n;
}
function encodeBounded(text) {
  return chunks(text).flatMap(chunk => encode(chunk, { allowedSpecial: 'all' }));
}
function textParts(m) {
  const parts = [m.role ?? 'unknown'];
  if (typeof m.content === 'string') parts.push(m.content);
  else if (Array.isArray(m.content)) for (const b of m.content) {
    if (b.type === 'text') parts.push(b.text ?? '');
    else if (b.type === 'thinking') parts.push(b.thinking ?? '');
    else if (b.type === 'toolCall') parts.push(b.name ?? '', JSON.stringify(b.arguments ?? {}));
  }
  if (m.role === 'system') {
    if (m.sections) parts.push(...Object.values(m.sections).filter(v => typeof v === 'string'));
    if (m.toolsAdded) parts.push(JSON.stringify(m.toolsAdded));
    if (m.toolsRemoved) parts.push(JSON.stringify(m.toolsRemoved));
  }
  if (typeof m.summary === 'string') parts.push(m.summary);
  if (m.role === 'bashExecution' && !m.excludeFromContext) parts.push(m.command ?? '', m.output ?? '');
  return parts;
}

export function messageKey(m) {
  // Stable across Pi's structuredClone; includes signatures so their changes invalidate state.
  return createHash('sha256').update(JSON.stringify([m.role, m.timestamp, m.toolCallId,
    m.content, m.summary, m.command, m.output, m.excludeFromContext])).digest('hex');
}

export function createCounter(policy = DEFAULT_POLICY) {
  const cache = new Map();
  let misses = 0;
  function tokens(m) {
    if (m.role === 'bashExecution' && m.excludeFromContext) return 0;
    const parts = textParts(m);
    const images = Array.isArray(m.content) ? m.content.filter(b => b.type === 'image').length : 0;
    const key = createHash('sha256').update(JSON.stringify(parts)).update(String(images)).digest('hex');
    if (cache.has(key)) return cache.get(key);
    misses++;
    // Incremental cached counts. A small per-message wire overhead is included.
    const n = parts.reduce((sum, s) => sum + countText(s), 12) + images * policy.imageTokens;
    cache.set(key, n);
    if (cache.size > policy.cacheEntries) cache.delete(cache.keys().next().value);
    return n;
  }
  return { tokens, total: messages => messages.reduce((s, m) => s + tokens(m), policy.requestMargin),
    stats: () => ({ size: cache.size, misses }) };
}

// Only request-local tool text is shortened. Images, flags, ids, signatures and raw records survive.
const previewCache = new Map();
export function previewMessage(m, policy = DEFAULT_POLICY, source = 'the original session history') {
  if (m.role !== 'toolResult' || !Array.isArray(m.content)) return m;
  const text = m.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
  const key = createHash('sha256').update(text).update(`${policy.toolTextTokens}:${source}`).digest('hex');
  if (previewCache.has(key)) {
    const preview = previewCache.get(key);
    if (preview === null) return m;
    let emitted = false;
    return { ...m, content: m.content.flatMap(b => b.type !== 'text' ? [b] : emitted ? [] :
      (emitted = true, [{ ...b, text: preview }])) };
  }
  const remember = value => {
    previewCache.set(key, value);
    if (previewCache.size > policy.cacheEntries) previewCache.delete(previewCache.keys().next().value);
  };
  if (countText(text, policy.toolTextTokens) <= policy.toolTextTokens) { remember(null); return m; }
  const notice = `\n[ACM tool preview only; full text remains in ${source}. Read/search a bounded range there if needed.]\n`;
  const room = policy.toolTextTokens - countText(notice) - 64;
  if (room <= 0) throw new Error('Tool preview budget too small');
  const head = encodeBounded(text.slice(0, room * 6));
  const tail = encodeBounded(text.slice(-room * 6));
  let preview = decode(head.slice(0, Math.floor(room * 0.65))) + notice + decode(tail.slice(-Math.floor(room * 0.35)));
  // Account for changed token merges at the splice.
  while (countText(preview) > policy.toolTextTokens) {
    preview = preview.slice(0, Math.floor(preview.length * 0.9));
  }
  remember(preview);
  let emitted = false;
  const content = [];
  for (const b of m.content) {
    if (b.type !== 'text') content.push(b);
    else if (!emitted) { content.push({ ...b, text: preview }); emitted = true; }
  }
  return { ...m, content };
}

// An assistant containing parallel calls and every corresponding result form ONE atomic interval.
// Interleaved user/custom messages inside that interval stay with it. No synthetic orphan repairs.
export function atomicGroups(rows) {
  const calls = new Map();
  const results = new Map();
  const end = rows.map((_, i) => i);
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].message;
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'toolCall') {
      if (calls.has(b.id)) throw new Error(`Duplicate tool call ${b.id}`);
      calls.set(b.id, i);
    }
    if (m.role === 'toolResult') {
      if (results.has(m.toolCallId)) throw new Error(`Duplicate tool result ${m.toolCallId}`);
      results.set(m.toolCallId, i);
    }
  }
  for (const [id, i] of results) {
    const c = calls.get(id);
    if (c === undefined || c >= i) throw new Error(`Orphan or out-of-order tool result ${id}`);
    end[c] = Math.max(end[c], i);
  }
  for (const [id] of calls) if (!results.has(id)) throw new Error(`Incomplete tool batch ${id}`);
  const groups = [];
  for (let i = 0; i < rows.length;) {
    let j = end[i];
    for (let k = i; k <= j; k++) j = Math.max(j, end[k]);
    groups.push({ start: i, end: j, rows: rows.slice(i, j + 1) });
    i = j + 1;
  }
  return groups;
}

export function assertPairing(messages) {
  atomicGroups(messages.filter(m => m.role !== 'system').map((message, i) => ({ id: String(i), message })));
}

// A failed transport frame is not a reusable assistant response. Preserve its raw
// session record, but never feed its unobserved opaque replay into the selector.
// Tool calls on a failed attempt have uncertain execution status: reconciliation,
// not omission, synthetic results or replay, is required.
export function omitFailedAttempts(rows) {
  return rows.filter(r => {
    const m = r.message;
    if (m.role !== 'assistant' || !['error', 'aborted'].includes(m.stopReason)) return true;
    if (m.content?.some?.(b => b.type === 'toolCall')) {
      throw new Error(`Failed attempt ${r.id} has tool calls; reconcile execution before continuing`);
    }
    return false;
  });
}

export function selectWindow(rows, counter, contextWindow, policy = DEFAULT_POLICY, protectedIds = [], fixedTokens = 0, force = false, worksetStartId = null) {
  const b = budgets(contextWindow, policy);
  if (!rows.length) throw new Error('Cannot create an empty token window');
  const groups = atomicGroups(rows);
  const mandatory = new Set([groups.length - 1]);
  if (worksetStartId !== null) {
    const start = groups.findIndex(g => g.rows.some(r => r.id === worksetStartId));
    if (start < 0) throw new Error('Protected working-span boundary missing; no automatic reset');
    for (let g = start; g < groups.length; g++) mandatory.add(g);
  }
  const protectedSet = new Set(protectedIds);
  if (protectedSet.size > policy.maxAnchors) throw new Error('Too many protected anchors');
  let latestUser = -1;
  let latestBatch = -1;
  for (let g = 0; g < groups.length; g++) {
    for (const row of groups[g].rows) {
      if (row.message.role === 'user') latestUser = g;
      if (row.message.role === 'assistant' && row.message.content?.some?.(x => x.type === 'toolCall')) latestBatch = g;
      if (protectedSet.has(row.id)) mandatory.add(g);
    }
  }
  if (latestUser >= 0) mandatory.add(latestUser);
  if (latestBatch >= 0) mandatory.add(latestBatch);
  if (!Number.isSafeInteger(fixedTokens) || fixedTokens < 0) throw new Error('Unknown/invalid fixed input budget; context preserved');
  const sizes = groups.map(g => g.rows.reduce((s, r) => {
    const n = counter.tokens(r.message);
    if (!Number.isSafeInteger(n) || n < 0 || !Number.isSafeInteger(s + n)) {
      throw new Error(`Unknown/invalid input budget at ${r.id}; context preserved`);
    }
    return s + n;
  }, 0));
  const before = fixedTokens + policy.requestMargin + sizes.reduce((a, n) => a + n, 0);
  if (!Number.isSafeInteger(before)) throw new Error('Unknown/invalid total input budget; context preserved');
  if (!force && before <= b.trigger) return { rows, carriedIds: [], firstKeptId: rows[0].id, before, after: before, changed: false };
  // A native observed-usage/overflow trigger can precede our visible-text estimate.
  // Still slide by the same configured trigger->target hysteresis ratio instead of canceling unchanged.
  const target = force ? Math.min(b.target, Math.floor(before * policy.targetRatio / policy.triggerRatio)) : b.target;
  const markerTokens = counter.tokens({ role: 'compactionSummary', summary: MARKER });
  if (!Number.isSafeInteger(markerTokens) || markerTokens < 0) throw new Error('Unknown/invalid marker budget; context preserved');
  let total = fixedTokens + policy.requestMargin + markerTokens;
  for (const g of mandatory) total += sizes[g];
  // Essential instructions/most recent batch too large: abort, never drop them or send an empty request.
  if (total > b.trigger) throw new Error(`Protected context needs ${total} tokens; safe input limit is ${b.trigger}`);
  const kept = new Set(mandatory);
  let tail = groups.length - 1;
  for (let g = groups.length - 2; g >= 0; g--) {
    if (kept.has(g)) { tail = g; continue; }
    if (total + sizes[g] > target) break;
    kept.add(g); total += sizes[g]; tail = g;
  }
  const selected = groups.flatMap((g, i) => kept.has(i) ? g.rows : []);
  const carried = groups.flatMap((g, i) => kept.has(i) && i < tail ? g.rows.map(r => r.id) : []);
  return { rows: selected, carriedIds: carried, firstKeptId: groups[tail].rows[0].id,
    before, after: total, changed: selected.length < rows.length };
}

// Branch-local migration: legacy explicit edits are applied, pressure breadcrumbs are NOT replayed.
export function branchState(branch) {
  let legacy = {};
  let state = { anchorIds: [], taskAnchorId: null, cursorId: null, carriedIds: [],
    worksetInitialized: false, worksetStartId: null, checkpointThroughId: null, lastGoodBoundary: null };
  for (const e of branch) {
    if (e.type === 'custom' && e.customType === 'acm') legacy = { ...legacy, ...e.data };
    if (e.type === 'compaction' && e.details?.acmPassive?.version === 1) {
      state = { ...state, cursorId: e.firstKeptEntryId, carriedIds: e.details.acmPassive.carriedIds ?? [],
        taskAnchorId: e.details.acmPassive.taskAnchorId ?? state.taskAnchorId };
    }
    if (e.type === 'custom' && e.customType === 'acm-passive') state = { ...state, ...e.data };
  }
  return { legacy, state };
}

export function applyLegacyRows(rows, legacy) {
  if (Object.keys(legacy.sniped ?? {}).length) throw new Error('Legacy ACM snipes require explicit migration; no automatic restoration');
  let out = rows.filter(r => !legacy.pruned?.[r.id]);
  if (legacy.summaryMarker) {
    const idx = out.findIndex(r => r.id === legacy.summaryMarker);
    if (idx >= 0) out = out.filter((r, i) => i >= idx || legacy.pinned?.[r.id]);
  }
  return out;
}

export function applyCursor(rows, state, branch) {
  if (!state.cursorId) return rows;
  const rank = new Map(branch.map((e, i) => [e.id, i]));
  const cut = rank.get(state.cursorId);
  if (cut === undefined) throw new Error('Token-window boundary is missing from active branch');
  const carry = new Set([...state.carriedIds, ...state.anchorIds]);
  return rows.filter(r => carry.has(r.id) || (rank.has(r.id) && rank.get(r.id) >= cut));
}
