# Credits & provenance

Spindle is an original product — a deterministic, model-free orchestration spine
(`spin`) with a typed-gate harness on top of it — but it stands on open-source work,
and it says so here in one honest place rather than scattering attribution through the
product surface. All upstreams below are MIT-licensed; the full notice lives in
[LICENSE](./LICENSE).

The rule the repo enforces (via `scripts/guard-no-fork-tells.js`): upstream source
names do **not** appear in `plugin/` prose. Per-file provenance, where it matters, is a
machine-readable `origin:` stamp in that file's frontmatter. Human-readable credit lives
here.

## What is Spindle's own

The part nobody else wrote — the reason Spindle exists as a distinct product:

- **The hard seam** — `spin` (the CLI in `src/`) NEVER calls a model; it is a pure,
  offline state machine and gatekeeper, and a guard test enforces that invariant.
- **Typed gates** (`G_DEFINE`/`G_DESIGN`/`G_BUILD`/`G_SHIP`/`G_KB_*`/`G_ROUTER_COVERAGE`/
  `G_REVIEW_BLOCK`/`G_AUDIT`/`G_OPS_CONFIG`/`G_PLAN`) as pure functions over `.spindle/`.
- **The exit-code ABI** (`0` pass / `1` gate-block / `2` usage / `3` crash) as the only
  thing that crosses the seam.
- **The crash-safe run-ledger** (`.spindle/run.json`, CLI-written only) and the typed
  **handoff sidecar** contracts.
- **The model-routing policy** (T0/T1/T2 orchestration tiers; verifier-outranks-generator;
  gate-backstopped downgrades) expressed as deterministic CLI routing.

## What was adapted, and from where

- **OpenSpec** (© 2024 OpenSpec Contributors, MIT) — the artifact-graph spine:
  Kahn topological ordering, schema validation, cycle detection, state detection, and the
  CLI build mechanics. Re-implemented in TypeScript in `src/core/artifact-graph/`.
- **AgentSpec** (© 2026 AgentSpec Contributors, MIT) — the 5-phase SDD workflow shape, the
  specialist agent roster (`plugin/agents/`), the knowledge-base domains (`plugin/kb/`),
  and the data-engineering command surface. Routed and gated by Spindle's harness; files
  carry an `origin:` stamp where adapted.
- **BoostPrompt** (© 2026 Airton Lira, MIT) — two deterministic scorers, re-implemented in
  TypeScript on Spindle's side of the seam: the discovery coverage / decision-clarity /
  readiness formulas in `src/core/validation/define-coverage.ts` (adapted from its
  `PromptQualityEvaluator`), and the self-containment + reference-URL lints in
  `src/core/validation/md-section-validator.ts` (adapted from its
  `PromptArtifactValidator`). Its nine discovery blocks also shape the `/brainstorm`
  interview doctrine. Only the model-free parts were taken — Spindle dispatches no
  agents from the CLI, and adopted none of its LLM orchestration.
- **ECC** (© 2026 Affaan Mustafa, MIT) — the original harness-pattern doctrine
  (adversarial gate, bounded loop, parallel fan-out, model routing) that inspired the
  four Spindle skills of the same names under `plugin/skills/`. Those skills have since
  been **re-authored from the code up** — each now fronts a concrete Spindle `src/`
  mechanism (e.g. `gReviewBlock`, `retryHandler`/`incRetry`, `parallel_group`,
  `TASK_KINDS`/`classifyTier`) that has no ECC counterpart, so they no longer carry an
  `origin:` stamp; this credit records the lineage of the idea, not of the code.

If you are looking for the legal notice, it is in [LICENSE](./LICENSE). If you find an
attribution gap, open an issue — getting credit right matters.
