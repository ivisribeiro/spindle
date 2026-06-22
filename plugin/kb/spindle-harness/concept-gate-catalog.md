# Gate Catalog

## Summary

Gates are pure deterministic predicates that enforce phase transitions. They are
registered by id in `src/core/gates/registry.ts` and invoked via `spin gate
<id>`. Exit 0 means pass; exit 1 means block with a `{gate, passed, reasons,
unmet}` payload. Commands must never advance a phase past an exit-1 gate.

## Definition

Every gate is a function `(ctx: GateContext) => GateResult` over filesystem
state and `.spindle/run.json`. No gate makes a network call, spawns a process,
or calls a model. The gate registry (`GATE_REGISTRY` in
`src/core/gates/registry.ts`) maps gate ids to implementations.

Gate ids are a closed set. As of the current codebase:

| Id | Source file | Guards |
|----|------------|--------|
| `G_DEFINE` | `sdd-gates.ts` | DEFINE.md has Why/What/Acceptance-Criteria sections + valid `define` handoff |
| `G_DESIGN` | `sdd-gates.ts` | DESIGN.md has Overview/File-Manifest/Decisions sections + manifest table + valid `design` handoff |
| `G_BUILD` | `sdd-gates.ts` | BUILD_REPORT exists; every design-manifest file on disk; every AC from DEFINE satisfied in build results; no phantom criteria; evidence files exist when `verified_by` looks like a path |
| `G_SHIP` | `sdd-gates.ts` | define.criteria minus build.passed is empty; no phantom criteria; spec-drift surfaced as warnings |
| `G_KB_STRUCTURE` | `kb-gates.ts` | `manifest.json`, `index.md`, `quick-reference.md` present; at least one `concept-*.md` |
| `G_KB_COVERAGE` | `kb-gates.ts` | every manifest slug has a `concept-<slug>.md`; each has a valid `kb-concept` handoff; `test_cases` meets `kb_min_test_cases` (default 1) |
| `G_ROUTER_COVERAGE` | `router-gate.ts` | bijection holds between agent roster and routing file; no missing, duplicate, or extra agents |
| `G_REVIEW_BLOCK` | `review-gate.ts` | surviving CRITICAL findings is 0 |
| `G_AUDIT` | `audit-gate.ts` | built[] items carry evidence files on disk |
| `G_OPS_CONFIG` | `ops-gate.ts` | ops controls present and enforced |
| `G_PLAN` | `plan-gate.ts` | plan artifact has required sections |

## Key Properties

- **Adding a gate** requires: pure predicate in `src/core`; registration in
  `GATE_REGISTRY`; tests with both passing and blocking fixtures; wiring into
  the relevant command's phase step.
- **CRITICAL-finding rule**: the verifier's tier must outrank or equal the
  generator's. `G_REVIEW_BLOCK` is the enforcement point — a cheap generator
  cannot be the final judge of its own CRITICAL findings.
- **`spin gate` flags**: `--agents <dir>` for `G_ROUTER_COVERAGE`;
  `--findings <file>` for `G_REVIEW_BLOCK`; `--routing <file>` for
  `G_ROUTER_COVERAGE`. See CLAUDE.md §4 for the full flag surface.
- **Block vs crash**: a blocked gate is exit 1 (domain outcome). A malformed
  `spin gate` invocation (wrong id, missing required flag) is exit 2. An
  internal error is exit 3.

## Relationships

- Exit-code ABI (concept-exit-code-abi.md) — the exit codes gates produce
- Handoff ABI (concept-handoff-abi.md) — several gates validate handoff sidecars
- Hard seam (concept-hard-seam.md) — gates live entirely on the deterministic side
- Run ledger (concept-run-ledger.md) — `recordGate()` writes gate verdicts to `run.json`

## Examples

Checking whether `/design` can proceed:

```bash
spin gate G_DEFINE
# exit 0 → DEFINE phase is complete; dispatch design worker
# exit 1 → stdout: {"gate":"G_DEFINE","passed":false,"reasons":["section 'Acceptance Criteria' missing"],"unmet":["section:Acceptance Criteria"]}
```

The `unmet` array names exactly what is missing. The command shows it and stops;
it does not proceed past the block.

## Test Cases

1. A call to `spin gate G_KB_STRUCTURE` against a domain directory that has
   `manifest.json` and `index.md` but no `concept-*.md` files must exit 1 with
   `unmet` containing `"concepts"`.
2. A call to `spin gate G_BUILD` where `define.criteria` contains `["AC-1"]`
   and `build-report.json` contains `results: [{criterion:"AC-1", status:"passed"}]`
   with no phantom criteria and all manifest files on disk must exit 0.
