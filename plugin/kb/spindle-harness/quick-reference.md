# spindle-harness — Quick Reference

## Exit codes

| Code | Meaning | Command must |
|------|---------|-------------|
| `0` | pass | proceed |
| `1` | gate blocked / handoff invalid | STOP; surface `{reasons,unmet}`; retry or halt |
| `2` | usage error (bad args) | fix the invocation — this is a command bug |
| `3` | internal crash | abort; do not retry blindly |

## Gate ids (closed set — `src/core/gates/registry.ts`)

| Gate | Guards | Blocks on |
|------|--------|----------|
| `G_DEFINE` | before /design | DEFINE.md missing sections or invalid `define` handoff |
| `G_DESIGN` | before /build | DESIGN.md missing sections, no manifest table, invalid `design` handoff |
| `G_BUILD` | before /ship | BUILD_REPORT missing, manifest files absent, AC not satisfied, phantom criteria |
| `G_SHIP` | inside /ship | define.criteria minus build.passed non-empty, or phantom criteria |
| `G_KB_STRUCTURE` | after /create-kb | domain dir missing, `manifest.json`/`index.md`/`quick-reference.md` absent, zero concept files |
| `G_KB_COVERAGE` | after /create-kb | a manifest slug has no `concept-<slug>.md`, invalid handoff, or too few test cases |
| `G_ROUTER_COVERAGE` | /gen-router | agent not in routing, duplicate, or routing references unknown agent |
| `G_REVIEW_BLOCK` | /review, /migrate | surviving CRITICAL findings > 0 |
| `G_AUDIT` | after /audit | built[] items without evidence files on disk |
| `G_OPS_CONFIG` | /audit ops check | prod config values unset or enforcement flags false |
| `G_PLAN` | /plan | plan artifact missing required sections |

## Handoff schema ids (closed set — `src/core/handoff/schemas.ts`)

| Id | Produced by | Key fields |
|----|-------------|------------|
| `define` | define worker | `feature`, `clarity`, `criteria[]` (AC-N ids), `open_questions[]` |
| `design` | design worker | `feature`, `manifest[]` ({file, action, purpose}), `decisions[]` |
| `build-task` | build task worker | `file`, `verification_passed`, `criteria_satisfied[]`, `issues[]` |
| `build-report` | build report worker | `feature`, `results[]`, `files_written[]`, `coverage?` |
| `finding` | review workers | `findings[]` ({file, line, severity, rule, message, source}) |
| `claim` | fact-check workers | `claims[]` ({id, text, verified?, verdict?, evidence?}) |
| `migration-plan` | migrate worker | `engine`, `steps[]`, `risks[]`, `rollback` |
| `claudemd-section` | sync-context worker | `section`, `strategy`, `content` |
| `kb-concept` | kb-concept-worker | `concept`, `summary`, `test_cases[]`, `needs_decoding` |
| `audit` | audit worker | `domain`, `built[]`, `gaps[]`, `weakPoints[]`, `opsReadiness[]`, `proposedTasks[]` |

## Route kinds by tier (`src/core/model-route/policy.ts`)

**Haiku** (mechanical, gate-backstopped): `file-read`, `structure-extract`, `frontmatter-parse`, `template-fill`, `format-convert`, `claim-extract`, `ship-prose`, `section-scan`, `router-assemble`

**Sonnet** (analysis / authoring): `spec-authoring`, `design-synthesis`, `code-build`, `kb-concept`, `finding-analysis`, `claim-verify`, `migration-plan`, `merge`

**Opus** (deepest + adversarial — never downgrade): `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge`, `equivalence-break`

## Orchestration tiers (`src/core/model-route/tiers.ts`)

| Tier | When | Agents | Adversary |
|------|------|--------|-----------|
| T0 | mechanical, lookup, or trivial held-context | 0 (main loop) | none |
| T1 | bounded analysis / authoring, or re-derivation of held context | 1 | optional single |
| T2 | broad discovery, high-risk, or irreversible | many (bounded) | selective |

## `spin` subcommands

`init` · `next` · `order` · `state` · `complete` · `validate` · `gate` · `diff-criteria` · `handoff-check` · `retry` · `route` · `schema` · `trace` · `eval` · `budget`

## Run-ledger structure (`.spindle/run.json`)

`version` · `schema` · `feature` · `completed[]` · `retries{}` · `gates{}` · `events[]` · `createdAt` · `updatedAt`

Event kinds: `complete` (with optional opaque `usage`), `gate`, `retry`.
