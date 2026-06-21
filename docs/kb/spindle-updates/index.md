# spindle-updates

A knowledge base of the updates made to Spindle during the 2026-06-21 session.
Built by dogfooding Spindle's own KB lane (`spin init --schema kb`), authored in
the main loop as a T1 task (the context was already held — no fan-out).

## Concepts
- [harness-core](concept-harness-core.md) — the deterministic `spin` spine (graph, run-state, gates, exit-code ABI).
- [model-routing](concept-model-routing.md) — per-agent tier Haiku/Sonnet/Opus; verifier outranks generator; downgrade only behind a gate.
- [orchestration-tiers](concept-orchestration-tiers.md) — T0/T1/T2; how much orchestration a task deserves; the re-derivation rule.
- [brownfield-audit](concept-brownfield-audit.md) — audit handoff + `brownfield` schema + gates G_AUDIT / G_OPS_CONFIG / G_PLAN + `reconcile` / `config-drift`.
- [dogfood-loop](concept-dogfood-loop.md) — use Spindle to improve Spindle; 39 frictions → 10 improvements; 93 → 189 tests.

## See also
- `quick-reference.md` — the commands/gates/numbers at a glance.
- `docs/IMPROVEMENTS_FROM_DOGFOOD.md` — the improvement backlog (all shipped).
- `docs/HARNESS.md` — the architecture source of truth.
