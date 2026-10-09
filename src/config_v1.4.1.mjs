// Shared by the producer and independent guard. Node built-ins only: never import
// window.mjs/tokenizer here, and never make a model or network request.
import { readFileSync, mkdirSync, rmdirSync, statSync, openSync, writeFileSync,
  fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_PERCENTAGES = Object.freeze({ triggerPercent: 95, targetPercent: 85 });
export const CONFIG_USAGE = '/acm-config：查看設定\n/acm-config 95 85：設定觸發％／保留目標％\n/acm-config reset：恢復 95％／85％';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validatePercentages(value) {
  if (!object(value) || !Number.isFinite(value.triggerPercent) || !Number.isFinite(value.targetPercent) ||
      !(0 < value.targetPercent && value.targetPercent < value.triggerPercent && value.triggerPercent < 100)) {
    throw new Error('ACM 比例必須是數字，且滿足 0 < 保留目標 < 觸發門檻 < 100。');
  }
  return { triggerPercent: value.triggerPercent, targetPercent: value.targetPercent };
}

export function parseConfigCommand(args) {
  const text = args.trim();
  if (!text) return null;
  if (text === 'reset') return { ...DEFAULT_PERCENTAGES };
  const parts = text.split(/\s+/);
  if (parts.length !== 2 || parts.some(p => !/^\d+(?:\.\d+)?%?$/.test(p))) {
    throw new Error(`用法錯誤。\n${CONFIG_USAGE}`);
  }
  return validatePercentages({ triggerPercent: Number(parts[0].replace('%', '')),
    targetPercent: Number(parts[1].replace('%', '')) });
}

export function policyForSettings(base, settings) {
  if (!Number.isSafeInteger(base?.contextCap) || base.contextCap <= 0 || base.noSummary !== true) {
    throw new Error('Invalid ACM base policy; no summary fallback.');
  }
  const percentages = validatePercentages(settings.acm === undefined ? DEFAULT_PERCENTAGES : settings.acm);
  return { ...base, triggerRatio: percentages.triggerPercent / 100, targetRatio: percentages.targetPercent / 100 };
}

export function nativeBudget(model, policy) {
  const window = model?.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error('Unknown model context window');
  const capacity = Math.min(window, policy.contextCap);
  const trigger = Math.floor(capacity * policy.triggerRatio);
  const target = Math.floor(capacity * policy.targetRatio);
  // Pi subtracts reserve from the ORIGINAL model window, not the ACM cap.
  return { capacity, trigger, target, reserve: window - trigger };
}

export function assertNativeSettings(settings, model, policy) {
  const b = nativeBudget(model, policy);
  const compaction = settings.compaction ?? {};
  const overrides = compaction.modelOverrides ?? {};
  const key = `${model?.provider}/${model?.id}`;
  const override = overrides[key] ?? {};
  if (!object(compaction) || !object(overrides) || !object(override) || compaction.enabled !== true ||
      (override.reserveTokens ?? compaction.reserveTokens ?? 16384) !== b.reserve ||
      (override.keepRecentTokens ?? compaction.keepRecentTokens ?? 20000) !== b.target) {
    throw new Error(`Pi compaction for ${key} must reserve ${b.reserve}, keep ${b.target}; run /acm-config with the current percentages while idle.`);
  }
  return b;
}

export function patchSettings(settings, model, base, percentages) {
  validatePercentages(percentages);
  const key = `${model?.provider}/${model?.id}`;
  if (!model?.provider || !model?.id) throw new Error('No active model');
  const compaction = settings.compaction ?? {};
  const overrides = compaction.modelOverrides ?? {};
  const previous = overrides[key] ?? {};
  if (!object(settings) || !object(compaction) || !object(overrides) || !object(previous) ||
      (settings.acm !== undefined && !object(settings.acm))) throw new Error('Invalid settings object; nothing was changed');
  const acm = { ...settings.acm, ...percentages };
  const b = nativeBudget(model, policyForSettings(base, { acm }));
  return { ...settings, acm, compaction: { ...compaction, enabled: true,
    reserveTokens: b.reserve, keepRecentTokens: b.target,
    modelOverrides: { ...overrides, [key]: { ...previous, reserveTokens: b.reserve, keepRecentTokens: b.target } } } };
}

function merge(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    // Settings may contain arbitrary keys; define an own property, never mutate a prototype.
    Object.defineProperty(result, key, { enumerable: true, configurable: true, writable: true,
      value: object(value) && object(base[key]) ? merge(base[key], value) : value });
  }
  return result;
}
const readOptional = path => {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};
const parseSettings = text => {
  const settings = text === undefined ? {} : JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(settings)) throw new Error('Invalid settings.json; nothing was changed');
  return settings;
};
const relevant = settings => JSON.stringify({ acm: settings.acm, compaction: settings.compaction });

function withSettingsLock(path, operation, release = rmdirSync) {
  mkdirSync(dirname(path), { recursive: true });
  // Same directory-lock name used by Pi/proper-lockfile. Keep this entire critical
  // section synchronous and short; contention is an explicit retry, not an overwrite.
  const lock = `${path}.lock`;
  try { mkdirSync(lock); } catch (error) {
    throw new Error(`設定檔目前無法鎖定，未變更設定；請稍後重試 (${error.code}).`);
  }
  const identity = statSync(lock);
  let result;
  try { result = operation(); return result; } finally {
    try {
      const current = statSync(lock);
      if (current.ino === identity.ino && current.birthtimeMs === identity.birthtimeMs) release(lock);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // A rename already committed the whole transaction. A cleanup failure
        // must NOT masquerade as a failed save and leave the runtime unsynced.
        if (result?.after !== undefined) result.lockCleanupWarning = `設定已完整儲存，但 lock 清理失敗 (${error.message})；若下次設定被鎖定，請先確認沒有其他 Pi 寫入。`;
        else throw error;
      }
    }
  }
}

export function atomicReplace(path, text, expected) {
  const temp = join(dirname(path), `.${randomUUID()}.acm-settings.tmp`);
  let fd;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    if (readOptional(path) !== expected) throw new Error('Settings changed during update; nothing was overwritten');
    renameSync(temp, path); // One atomic replacement: percentages and native budgets commit together.
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function commitConfig({ path, cwd, projectTrusted, runtimeSettings, model, base, percentages,
  replace = atomicReplace, releaseLock }) {
  return withSettingsLock(path, () => {
    const before = readOptional(path);
    const global = parseSettings(before);
    // Do not read or write an untrusted project's settings.
    const project = projectTrusted ? parseSettings(readOptional(join(cwd, '.pi', 'settings.json'))) : {};
    const effective = merge(global, project);
    if (relevant(effective) !== relevant(runtimeSettings)) {
      throw new Error('磁碟與執行中設定不同；請先在閒置時 /reload。SDK 自訂 agentDir 必須同時設定 PI_CODING_AGENT_DIR。未變更設定。');
    }
    const next = patchSettings(global, model, base, percentages);
    const predicted = merge(next, project);
    const policy = policyForSettings(base, predicted);
    if (policy.triggerRatio !== percentages.triggerPercent / 100 || policy.targetRatio !== percentages.targetPercent / 100) {
      throw new Error('專案 ACM 設定覆蓋使用者比例；未變更任何設定。');
    }
    assertNativeSettings(predicted, model, policy); // Reject conflicting project overrides before writing.
    const after = `${JSON.stringify(next, null, 2)}\n`;
    replace(path, after, before);
    return { path, before, after };
  }, releaseLock);
}

export function rollbackConfig(receipt) {
  return withSettingsLock(receipt.path, () => {
    if (readOptional(receipt.path) !== receipt.after) {
      throw new Error('設定檔已有後續變更，未強制覆寫；請檢查設定並在閒置時 /reload。');
    }
    if (receipt.before === undefined) unlinkSync(receipt.path);
    else atomicReplace(receipt.path, receipt.before, receipt.after);
  });
}
