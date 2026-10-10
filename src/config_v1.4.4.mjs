// Shared by the producer and independent guard. Node built-ins only: never import
// window.mjs/tokenizer here, and never make a model or network request.
import { readFileSync, mkdirSync, rmdirSync, statSync, openSync, writeFileSync,
  fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const DEFAULT_PERCENTAGES = Object.freeze({ triggerPercent: 70, targetPercent: 55 });
export const CONFIG_USAGE = '/acm-config：查看設定\n/acm-config 70 55：設定觸發％／保留目標％\n/acm-config reset：恢復 70％／55％';
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

export class NativeSettingsMismatch extends Error {
  constructor(message) { super(message); this.name='NativeSettingsMismatch'; this.code='ACM_NATIVE_SETUP_REQUIRED'; }
}
export function assertNativeSettings(settings, model, policy) {
  const b = nativeBudget(model, policy);
  const compaction = settings.compaction ?? {};
  const overrides = compaction.modelOverrides ?? {};
  const key = `${model?.provider}/${model?.id}`;
  const override = overrides[key] ?? {};
  if (!object(compaction) || !object(overrides) || !object(override) || compaction.enabled !== true ||
      ['reserveTokens','keepRecentTokens'].some(field=>compaction[field]!==undefined && (!Number.isSafeInteger(compaction[field])||compaction[field]<0)) ||
      (override.reserveTokens ?? compaction.reserveTokens ?? 16384) !== b.reserve ||
      (override.keepRecentTokens ?? compaction.keepRecentTokens ?? 20000) !== b.target) {
    throw new NativeSettingsMismatch(`ACM 尚未同步 ${key} 的 Pi compaction budget（reserve ${b.reserve} / keep ${b.target}）；請在閒置時 /acm-setup。`);
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

// Setup owns only ACM percentages/ownership plus the selected model override.
// Ordinary/global token budgets and other model overrides remain byte-equivalent data.
function setupNext(global, model, base, percentages) {
  const key=`${model.provider}/${model.id}`;
  const budget=nativeBudget(model,policyForSettings(base,{acm:percentages}));
  const previous=global.acm?.autoInit;
  if (previous!==undefined && (!object(previous)||previous.version!==1||!object(previous.models))) throw new Error('Invalid ACM ownership metadata; nothing was changed');
  const acm={...global.acm,...percentages,autoInit:{version:1,models:{...previous?.models,[key]:{reserveTokens:budget.reserve,keepRecentTokens:budget.target}}}};
  const compaction=global.compaction??{}, overrides=compaction.modelOverrides??{};
  if(!object(compaction)||!object(overrides)||!object(overrides[key]??{}))throw new Error('Invalid compaction settings');
  return {...global,acm,compaction:{...compaction,enabled:true,modelOverrides:{...overrides,[key]:{...overrides[key],reserveTokens:budget.reserve,keepRecentTokens:budget.target}}}};
}
function setupSnapshot({path,cwd,projectTrusted,runtimeSettings,model,base}) {
  if(!model?.provider||!model?.id)throw new Error('No active model; wait for model selection');
  const before=readOptional(path),global=parseSettings(before);
  const projectText=projectTrusted?readOptional(join(cwd,'.pi','settings.json')):undefined;
  const project=projectTrusted?parseSettings(projectText):{};
  const effective=merge(global,project);
  if(relevant(effective)!==relevant(runtimeSettings))throw new Error('磁碟與執行中設定不同；請閒置 /reload 後再試，未變更設定。');
  const percentages=validatePercentages(effective.acm===undefined?DEFAULT_PERCENTAGES:effective.acm);
  const policy=policyForSettings(base,effective),budget=nativeBudget(model,policy),key=`${model.provider}/${model.id}`;
  const fingerprint=createSetupFingerprint(before,projectText,model,base,percentages);
  const effectiveCompaction=effective.compaction??{};
  if(!object(effectiveCompaction) || (effectiveCompaction.enabled!==undefined && typeof effectiveCompaction.enabled!=='boolean') ||
    ['reserveTokens','keepRecentTokens'].some(field=>effectiveCompaction[field]!==undefined && (!Number.isSafeInteger(effectiveCompaction[field])||effectiveCompaction[field]<0))){
    return {kind:'blocked',key,percentages,budget,fingerprint,reason:'全域／專案 compaction 設定格式或 token 值無效；請先修正，ACM 不會以模型 override 遮蔽它。',before,global};
  }
  try{assertNativeSettings(effective,model,policy);return {kind:'ready',key,percentages,budget,fingerprint,before,global};}
  catch(error){if(error.code!=='ACM_NATIVE_SETUP_REQUIRED')throw error;}
  const globalPercentages=validatePercentages(global.acm===undefined?DEFAULT_PERCENTAGES:global.acm);
  if(globalPercentages.triggerPercent!==percentages.triggerPercent || globalPercentages.targetPercent!==percentages.targetPercent){
    return {kind:'blocked',key,percentages,budget,fingerprint,reason:'專案 ACM 比例覆蓋使用者比例；請在專案明確設定對應 native budget，ACM 不會改寫全域比例。',before,global};
  }
  const next=setupNext(global,model,base,percentages),predicted=merge(next,project);
  try{assertNativeSettings(predicted,model,policyForSettings(base,predicted));}
  catch{ return {kind:'blocked',key,percentages,budget,fingerprint,reason:'受信任專案設定覆蓋 native budget；請調整專案設定，ACM 不會改寫它。',before,global}; }
  const comp=global.compaction??{},override=comp.modelOverrides?.[key]??{},owned=global.acm?.autoInit?.version===1?global.acm.autoInit.models?.[key]:undefined;
  const conflicts=[];
  if(comp.enabled===false)conflicts.push('已明確關閉 compaction');
  for(const [field,wanted,fallback]of [['reserveTokens',budget.reserve,16384],['keepRecentTokens',budget.target,20000]]){
    if(override[field]!==undefined && override[field]!==wanted && override[field]!==owned?.[field])conflicts.push(`目前模型的 ${field} 已自訂`);
    if(override[field]===undefined && comp[field]!==undefined && comp[field]!==fallback && comp[field]!==wanted)conflicts.push(`全域 ${field} 已自訂`);
  }
  return {kind:conflicts.length?'conflict':'automatic',key,percentages,budget,fingerprint,reason:conflicts.join('；'),before,global,next};
}
function createSetupFingerprint(before,projectText,model,base,percentages) {
  // No paths, credentials or complete settings are emitted to UI/receipts.
  return createHash('sha256').update(JSON.stringify([before,projectText,model.provider,model.id,model.contextWindow,base.contextCap,percentages])).digest('hex');
}
export function inspectSetup(options) {
  const {kind,key,percentages,budget,fingerprint,reason}=setupSnapshot(options);
  return {kind,key,percentages,budget,fingerprint,reason};
}
export function commitSetup(options,{fingerprint,confirmed=false}={}) {
  return withSettingsLock(options.path,()=>{
    const snapshot=setupSnapshot(options);
    if(snapshot.fingerprint!==fingerprint)throw new Error('初始化確認後設定或模型已變更；未寫入，請重新 /acm-setup。');
    if(snapshot.kind==='ready')return null;
    if(snapshot.kind==='blocked')throw new Error(snapshot.reason);
    if(snapshot.kind==='conflict'&&!confirmed)throw new Error('ACM 初始化有設定衝突，需要確認；未寫入。');
    const after=JSON.stringify(snapshot.next,null,2)+'\n';
    (options.replace??atomicReplace)(options.path,after,snapshot.before);
    return {path:options.path,before:snapshot.before,after};
  },options.releaseLock);
}
