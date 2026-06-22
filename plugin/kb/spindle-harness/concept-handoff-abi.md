# Handoff ABI

## Summary

A handoff is a typed JSON sidecar a worker writes alongside its markdown
artifact. When a command calls `spin complete <id> --handoff <file>`, the CLI
validates the sidecar against the named Zod schema before the artifact counts as
done. This makes self-marking impossible: the model cannot advance a phase by
claiming completion — the type system enforces the contract first.

## Definition

Handoff schema ids are a closed set defined in
`src/core/handoff/schemas.ts` (`HANDOFF_SCHEMAS` record). Each id maps to a
Zod schema. The `handoff:` field in a workflow artifact's YAML declares which id
applies; `spin complete --handoff <sidecar>` runs `handoff-check` against it.

Current schema ids and their key fields:

| Id | Key required fields |
|----|--------------------|
| `define` | `feature` (string), `clarity` (0-1), `criteria[]` (AC-N bare ids), `open_questions[]` |
| `design` | `feature`, `manifest[]` ({file, action: create/modify/delete, purpose}), `decisions[]` |
| `build-task` | `file`, `verification_passed` (bool), `criteria_satisfied[]` (AC-N ids), `issues[]` |
| `build-report` | `feature`, `results[]` ({criterion AC-N, status passed/failed/skipped, corrected_spec?, correction?, reconciled?, verified_by?}), `files_written[]`, optional `coverage` ({tool, pct, threshold}) |
| `finding` | `findings[]` ({file, line?, severity: critical/high/medium/low, rule, message, source}) — `findings` is REQUIRED (no default — so `{}` fails loudly rather than passing as `{findings:[]}`) |
| `claim` | `claims[]` ({id, text, verified?, verdict: true/false/unverifiable?, evidence?}) |
| `migration-plan` | `engine`: dbt/spark/sql/other, `steps[]` (min 1), `risks[]`, `rollback` |
| `claudemd-section` | `section`, `strategy`: preserve/replace/merge, `content` |
| `kb-concept` | `concept` (slug), `summary`, `test_cases[]`, `needs_decoding` (bool) |
| `audit` | `domain`, `built[]` (each with `evidence.files[]` + `status`: proven/partial/scaffolded), `gaps[]`, `weakPoints[]`, `opsReadiness[]`, `proposedTasks[]` |

## Key Properties

- **`spin handoff-check <schemaId> <file>`**: standalone validation, exits 0/1.
  Use to debug before `spin complete`.
- **KB graph exception**: the kb graph's four artifact ids (`manifest`,
  `concepts`, `quick-reference`, `index`) declare no `handoff:` field. `spin
  complete <id>` for these ids does NOT run `G_HANDOFF`. Per-slug `kb-concept`
  sidecars are validated by `G_KB_COVERAGE` at gate time, not at completion time.
- **`criteria` must be bare AC-N ids**: the `define` schema enforces the regex
  `/^AC-\d+$/` on each entry. Prose acceptance criteria in the array fail
  validation with a specific message pointing to the correct format.
- **`findings` with no default**: an auditor JSON that omits the `findings` key
  entirely fails validation — the schema has no `.default([])` on that field.
  This prevents a dropped CRITICAL finding from silently passing `G_REVIEW_BLOCK`.
- **`corrected_spec` + `reconciled`**: when a build implements an AC differently
  from what DEFINE stated, `corrected_spec: true` + `correction` forces the
  discrepancy to be explicit. `reconciled: true` marks that DEFINE.md has been
  updated, so `spin spec-drift` converges instead of blocking forever.

## Relationships

- Gate catalog (concept-gate-catalog.md) — `G_DEFINE`, `G_DESIGN`, `G_BUILD`,
  `G_SHIP`, `G_KB_COVERAGE`, `G_AUDIT` all read handoff sidecars
- Hard seam (concept-hard-seam.md) — handoffs are how workers communicate
  results across the seam to the deterministic side
- Exit-code ABI (concept-exit-code-abi.md) — an invalid handoff at `spin
  complete` exits 1, triggering a retry loop

## Examples

A valid `kb-concept` sidecar:

```json
{
  "concept": "hard-seam",
  "summary": "The process boundary separating src/ from plugin/.",
  "test_cases": [
    "A src/ file that imports @anthropic-ai must fail the guard test.",
    "A worker writing run.json directly bypasses the determinism guarantee."
  ],
  "needs_decoding": false
}
```

A `define` sidecar with a formatting error that would fail validation:

```json
{
  "feature": "auth-gate",
  "clarity": 0.9,
  "criteria": ["AC-1: the gate must block if ..."],
  "open_questions": []
}
```

The entry `"AC-1: the gate must block if ..."` fails the `/^AC-\d+$/` regex;
`spin complete define --handoff define.json` exits 1 with the guidance message.

## Test Cases

1. A `kb-concept` sidecar with `test_cases: []` (empty array) must pass
   `spin handoff-check kb-concept` (the schema allows zero entries; `G_KB_COVERAGE`
   enforces the minimum count separately via `kb_min_test_cases`).
2. A `finding` sidecar written as `{}` (empty object) must fail
   `spin handoff-check finding` with an error naming the missing `findings` field.
