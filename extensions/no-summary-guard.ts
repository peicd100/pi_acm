import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { policyForSettings, nativeBudget } from '../src/config_v1.4.4.mjs';

// No tokenizer or external runtime dependency. Even an invalid/missing policy or
// producer must leave native/manual/overflow/tree AI summarization cancelled.
export default function noSummaryGuard(pi: ExtensionAPI) {
  let base: any;
  try { base = JSON.parse(readFileSync(new URL('../policy.json', import.meta.url), 'utf8')); } catch { /* fail closed per request */ }
  const requests = new WeakMap<object, number>();
  const blocked = new WeakSet<object>();
  pi.events.on('acm-passive:request-blocked',(data:any)=>{if(Array.isArray(data?.messages))blocked.add(data.messages);});
  pi.events.on('acm-passive:request-ready', (data: any) => {
    if (Array.isArray(data?.messages) && Number.isSafeInteger(data?.estimatedTokens) && data.estimatedTokens > 0) {
      requests.set(data.messages, data.estimatedTokens);
    }
  });
  pi.on('session_before_compact', () => ({ cancel: true }));
  pi.on('context_with_system', (event, ctx) => {
    if(blocked.delete(event.messages)){
      requests.delete(event.messages);
      try{ctx.abort();}catch{ /* request was already aborted by the producer */ }
      return; // Quiet cancellation, never an approval and never a model fallback.
    }
    const n = requests.get(event.messages);
    requests.delete(event.messages); // Exact array identity, one-shot, including failed validations.
    try {
      const policy = policyForSettings(base, pi.getSettings());
      const b = nativeBudget(ctx.model, policy);
      if (n === undefined || n > b.trigger) throw new Error('Missing/oversized approval');
    } catch {
      try { ctx.abort(); } catch { /* lifecycle already terminated */ }
      throw new Error('Passive ACM request verification missing/invalid; request aborted, no summary fallback.');
    }
  });
  pi.on('session_before_tree', event => {
    if (event.preparation.userWantsSummary) return { cancel: true };
  });
}
