# Model Routing Policy

This document defines how the harness selects a model tier for every worker agent
dispatch. The authoritative command is `spin route <taskKind> [--budget std|low]`.
No command, skill, or worker agent may override its output.

---

## Tier table

| Tier | Model | Task-kinds |
|------|-------|------------|
| **HAIKU** | haiku | `file-read` `structure-extract` `frontmatter-parse` `template-fill` `format-convert` `claim-extract` `ship-prose` `section-scan` `router-assemble` |
| **SONNET** | sonnet | `spec-authoring` `design-synthesis` `code-build` `kb-concept` `finding-analysis` `claim-verify` `migration-plan` `merge` |
| **OPUS** | opus | `architect` `define-intent` `design-intent` `adversary` `review-judge` `equivalence-break` |

Call `spin route <taskKind>` before every dispatch. It returns `{ tier, model, reason }`.
Dispatch the worker on the returned model — do not hardcode a tier in a command or skill.

---

## Two hard rules

### Rule 1 — Verifier outranks or equals generator on CRITICAL gates

Whenever a gate is CRITICAL (G_REVIEW_BLOCK, G_SHIP, or any gate whose `reasons`
surface a `CRITICAL` finding), the model running the verifier or adversary check
MUST be the same tier or higher than the model that produced the artifact under
review. A cheaper tier is never the final judge of a CRITICAL finding.

Concretely: if a SONNET worker produced a design artifact, the `adversary` task-kind
that reviews it routes to OPUS — satisfying the rule. A HAIKU tier may never
adjudicate a CRITICAL gate result produced by SONNET or OPUS.

### Rule 2 — Downgrade under `--budget low` only where a deterministic gate backstops the output

Under `--budget low`, `spin route` may lower a tier by one step **only** when a
deterministic gate (`spin gate <id>`) will verify the output before the phase
advances. The downgrade is safe because the gate, not the model, is the final
arbiter of correctness.

**Critical kinds are never downgraded regardless of budget flag:**
`adversary`, `architect`, `review-judge`, `define-intent`, `design-intent`,
`equivalence-break` always resolve to OPUS even under `--budget low`.

---

## `--budget low` behavior

`spin route <kind> --budget low` applies the following shifts where a gate backstops:

| Task-kind | Standard tier | `--budget low` tier | Backstopping gate |
|-----------|---------------|---------------------|-------------------|
| `code-build` | SONNET | HAIKU | G_BUILD |
| `kb-concept` | SONNET | HAIKU | G_KB_COVERAGE |
| `merge` | SONNET | HAIKU | deterministic merge assist (floor=haiku) |
| OPUS non-critical | OPUS | SONNET | only non-critical OPUS kinds (none currently) |

**Non-downgradable SONNET kinds** (`downgradable: false` in policy.ts) remain
SONNET under `--budget low`: `spec-authoring`, `design-synthesis`,
`finding-analysis`, `claim-verify`, `migration-plan`. G_DEFINE, G_DESIGN,
G_KB_STRUCTURE, and G_ROUTER_COVERAGE do not backstop any tier shift — they
govern phases where the kinds are already at their floor tier.

Critical kinds (`adversary`, `architect`, `review-judge`, `*-intent`,
`equivalence-break`) are **exempt** — `--budget low` has no effect on them.

---

## Worked examples

### Example 1 — `spin route adversary` under `--budget low`

```
$ spin route adversary --budget low
{ "tier": "opus", "model": "claude-opus-…", "reason": "critical kind; budget flag ignored" }
```

`adversary` is a critical kind. Rule 1 requires the verifier to outrank or equal
the generator. Rule 2 does not permit downgrade because no deterministic gate
replaces adversarial judgment. The result is OPUS regardless of `--budget low`.

The harness dispatches the adversary worker on OPUS and proceeds with
`spin complete <id> --handoff <sidecar>`. If the handoff schema is invalid (exit 1),
`spin retry <id> --inc` increments the counter; at the ceiling `spin retry <id> --ok`
exits 1 and the command surfaces the block to the user.

### Example 2 — `spin route code-build --budget low` → HAIKU via G_BUILD

```
$ spin route code-build --budget low
{ "tier": "haiku", "model": "claude-haiku-…", "reason": "G_BUILD backstops; downgrade permitted" }
```

`code-build` is a SONNET kind. Under `--budget low` it is eligible for downgrade
because G_BUILD provides a deterministic backstop: before `/ship` proceeds,
`spin gate G_BUILD` verifies that every manifest file exists on disk, the
criteria-diff is empty, and the BUILD_REPORT is present. If the HAIKU worker
produces incomplete or incorrect artifacts, G_BUILD exits 1 and blocks the phase —
the harness surfaces `{gate, passed:false, reasons, unmet}` and does not advance.
The model never self-certifies correctness; the gate does.

Dispatch sequence:

```
# 1. Learn ready artifacts
spin next
# -> { ready: [{ id: "BUILD-impl", model: "haiku", parallel_group: 0 }], ... }

# 2. Route (budget flag confirms downgrade)
spin route code-build --budget low
# -> { tier: "haiku", ... }

# 3. Dispatch HAIKU worker via Task, worker writes artifact + handoff sidecar

# 4. Complete with handoff validation
spin complete BUILD-impl --handoff .spindle/features/my-feature/.handoffs/BUILD-impl.json
# exit 0 -> marked complete; exit 1 -> re-dispatch (bounded by retry cap)

# 5. Gate check before /ship
spin gate G_BUILD
# exit 0 -> proceed to /ship
# exit 1 -> STOP; surface reasons + unmet; do not advance
```

The haiku worker's output is only accepted if G_BUILD passes — satisfying Rule 2.

---

## Full dispatch sequence (reference)

Every workflow command follows this loop. Model routing is one step in it:

```
1.  spin next
    -> ready:[{id, model, parallel_group}], blocked:{}, complete:bool

2.  For each ready artifact (fan out parallel_group in ONE message):
      spin route <taskKind> [--budget std|low]
      -> { tier, model, reason }
      Dispatch worker via Task on that model.

3.  Worker writes markdown artifact + JSON handoff sidecar
    (sidecar schema: one of define|design|build-task|build-report|
     finding|claim|migration-plan|claudemd-section|kb-concept)

4.  spin complete <id> --handoff <sidecar>
    exit 0 -> marked complete
    exit 1 -> handoff invalid; spin retry <id> --inc  (re-dispatch)
              at ceiling:  spin retry <id> --ok  exits 1 -> surface block

5.  spin gate <gateId>
    exit 0 -> advance to next phase
    exit 1 -> STOP; surface {gate, passed, reasons, unmet}; do not advance
```

Gates by phase:

| Before phase | Gate | What it checks |
|--------------|------|----------------|
| `/design` | `G_DEFINE` | DEFINE sections present, AC-n ids valid, define handoff valid |
| `/build` | `G_DESIGN` | manifest table present, design handoff valid |
| `/ship` | `G_BUILD` | every manifest file on disk, criteria-diff empty, BUILD_REPORT exists |
| `/ship` final | `G_SHIP` | define.criteria minus build.passed is empty |
| KB phase | `G_KB_STRUCTURE`, `G_KB_COVERAGE` | KB structural checks, concept coverage |
| Router phase | `G_ROUTER_COVERAGE` | agent→routing bijection, no silent skips |
| Review/migrate | `G_REVIEW_BLOCK` | surviving CRITICAL findings > 0 blocks |

Handoff validation (`spin handoff-check <schemaId> <file.json>`) can be run
standalone for debugging before `spin complete`.

---

## Quick reference

```bash
# What model for this task?
spin route spec-authoring
spin route adversary --budget low   # always returns opus

# Inspect current routing decision for all ready artifacts
spin next   # model hint in each ready[] entry

# Check a gate manually
spin gate G_BUILD
spin gate G_REVIEW_BLOCK --findings .spindle/features/foo/.handoffs/review.json

# Validate a handoff before completing
spin handoff-check build-report .spindle/features/foo/.handoffs/BUILD-impl.json

# Advance with retry logic
spin complete BUILD-impl --handoff .spindle/features/foo/.handoffs/BUILD-impl.json
spin retry BUILD-impl --inc   # if exit 1
spin retry BUILD-impl --ok    # at ceiling -> exits 1, surface block
```
