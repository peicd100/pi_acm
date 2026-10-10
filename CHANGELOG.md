# Changelog

## 1.4.3 — Target-route counting

- Add counting-only Responses projection for audited Pi1.1.0: foreign encrypted/redacted thinking is not charged as replay, visible foreign summaries remain; compatible signed replay keeps original-output reserve.
- New immutable calibration/projection modules with version2 countingRule records; valid legacy version1 records retain response binding but cannot train the new basis. Route/rule samples remain separate; unaudited host/custom API fallback stays conservative.
- Do not mutate raw history/request/tool IDs/signatures, reset cursor/anchors, resurrect cropped prefixes or share provider cache. Native footer stays unchanged.
- Add SDK serializer differential, same/foreign/unknown/unsigned/redacted fixtures and A→B→A/reload/cursor/tool-pairing regression tests. No Docker live update/reload or real provider traffic for validation.

## 1.4.2 — Idle automatic initialization

- Automatically initialize fresh interactive TUI profiles (95/85), preserve custom ratios and synchronize newly selected models only at idle/empty-queue boundaries.
- Add /acm-setup; use documented command dispatch/reload, not private SDK setters or lifecycle reload calls. Init does not become a model prompt.
- Write selected-model overrides and ownership only; keep ordinary budgets and other models. Ask before explicit budget/disabled conflicts, block trusted-project conflicts, and never read untrusted project settings.
- Keep atomic lock/CAS, stale-consent rejection and rollback protections. No automatic personal writes in SDK/print/RPC.
- Quietly cancel expected unsynchronized requests without duplicate producer/guard stacks; exact-array one-shot guard still aborts, never approves.
- Retain immutable config1.4.1/window1.4.1; new config_v1.4.2 for reload safety. No sliding algorithm or summary fallback change.

## 1.4.1 — Default 95/85

- Set fresh-install, pure-engine and `/acm-config reset` defaults to 95% trigger / 85% target.
- Preserve explicit user percentages and all no-summary, task-anchor and tool-pairing protections.
- Use versioned window/config modules for same-process reload safety; add default/reload regression tests.

## 1.4.0 — Git distribution packaging

- Package the existing passive 1.4.0 no-summary sliding-window implementation.
- Preserve producer/guard order, default 80% trigger and 70% target.
- Add explicit Pi manifest, fixed runtime dependency, portable test SDK lookup,
  package validation, isolated Git install smoke test and release instructions.
- Add production/development dependency separation and lockfile.
- Exclude local memory, instructions, credentials and generated dependencies.
- Runtime source/policy behavior unchanged; open-source license choice pending.
