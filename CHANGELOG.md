# Changelog

## 1.4.0 — Git distribution packaging

- Package the existing passive 1.4.0 no-summary sliding-window implementation.
- Preserve producer/guard order, default 80% trigger and 70% target.
- Add explicit Pi manifest, fixed runtime dependency, portable test SDK lookup,
  package validation, isolated Git install smoke test and release instructions.
- Add production/development dependency separation and lockfile.
- Exclude local memory, instructions, credentials and generated dependencies.
- Runtime source/policy behavior unchanged; open-source license choice pending.
