# Model Routing

## Summary

Model routing has two orthogonal axes: the **task-kind tier** (which model for a
given artifact or agent: Haiku / Sonnet / Opus) and the **orchestration tier**
(how much orchestration the whole task deserves: T0 / T1 / T2). Both are
deterministic lookups in `src/core/model-route/`; neither calls a model.

## Definition

### Task-kind tier (`policy.ts`)

`spin route <kind>` resolves a task kind to `{tier, model, budget, reason}` via
`TASK_KINDS` in `src/core/model-route/policy.ts`. Model ids from the same file:

```
haiku  → claude-haiku-4-5-20251001
sonnet → claude-sonnet-4-6
opus   → claude-opus-4-8
```

**Tier classification:**

- **Haiku** — mechanical tasks where a downstream gate catches mistakes:
  `file-read`, `structure-extract`, `frontmatter-parse`, `template-fill`,
  `format-convert`, `claim-extract`, `ship-prose`, `section-scan`,
  `router-assemble`.
- **Sonnet** — analysis / authoring: `spec-authoring`, `design-synthesis`,
  `code-build`, `kb-concept`, `finding-analysis`, `claim-verify`,
  `migration-plan`, `merge`.
- **Opus** — deepest reasoning + adversarial; never downgrade: `architect`,
  `define-intent`, `design-intent`, `adversary`, `review-judge`,
  `equivalence-break`.

**Two hard routing rules:**
1. The verifier/adversary tier must outrank or equal the generator on any
   CRITICAL gate. `adversary`, `architect`, `review-judge`, and `*-intent` kinds
   have `floor: opus` and `downgradable: false`.
2. `--budget low` may downgrade a tier by one level ONLY if a deterministic gate
   backstops the output (`downgradable: true`). `kb-concept` is downgradable
   (G_KB_COVERAGE backstops); `finding-analysis` is not.

Default: cheapest tier that verifiably does the task.

### Orchestration tier (`tiers.ts`)

`classifyTier(signals)` in `src/core/model-route/tiers.ts` maps task signals to
a `TierDecision`. Signals:

| Signal | Effect |
|--------|--------|
| `mechanical: true` | → T0 (main loop, no subagents) |
| `risk: 'high'` or `reversible: false` | → T2 (fan-out + adversary) |
| `haveContext: true` | → T1 (re-derivation; never N agents re-reading held material) |
| `breadth: 'many'` | → T2 (discovery across unfamiliar material) |
| otherwise bounded | → T1 |

Orchestration shapes:

- **T0**: main loop only; 0 subagents; no adversary.
- **T1**: 1 subagent on the cheapest working model; at most 1 optional adversary.
- **T2**: bounded fan-out; shared context; adversary on critical items only;
  budget cap required.

## Key Properties

- The task-kind tier and the orchestration tier are independent decisions.
  A T2 orchestration (fan-out) can use Sonnet workers.
- `spin route` is a pure read — exit 0 always; no blocking.
- The routing table is the closed set in CLAUDE.md §5. A command referencing an
  unknown task kind gets `UnknownTaskKindError` (exit 2 at the CLI).
- `G_ROUTER_COVERAGE` enforces that every agent declared in `plugin/agents/` has
  exactly one entry in the generated routing file. A new agent with no route is
  a gate failure.
- Budget cap for T2 is `required`; for T1 it is `recommended`; T0 has none.

## Relationships

- Hard seam (concept-hard-seam.md) — routing lives on the deterministic side
- Gate catalog (concept-gate-catalog.md) — `G_ROUTER_COVERAGE` enforces agent
  roster bijection
- Run ledger (concept-run-ledger.md) — model-reported usage (tier, model,
  tokens) is recorded opaquely in `events[]` but never computed by the CLI

## Examples

Routing a KB concept worker:

```bash
spin route kb-concept
# → {"kind":"kb-concept","tier":"sonnet","model":"claude-sonnet-4-6","budget":"std","reason":"concept authoring, G_KB_COVERAGE backstops"}

spin route kb-concept --budget low
# → {"kind":"kb-concept","tier":"haiku","model":"claude-haiku-4-5-20251001","budget":"low","reason":"concept authoring, G_KB_COVERAGE backstops; downgraded under --budget low (gate-backstopped, floor=haiku)"}
```

Routing an adversarial challenger (non-downgradable):

```bash
spin route adversary
# → {"kind":"adversary","tier":"opus","model":"claude-opus-4-8","budget":"std","reason":"adversarial challenger — must outrank generator"}

spin route adversary --budget low
# → same as above; downgradable: false, floor: opus — budget flag has no effect
```

## Test Cases

1. `spin route kb-concept --budget low` must return tier `haiku` (downgradable;
G_KB_COVERAGE backstops).
2. `spin route adversary --budget low` must return tier `opus` (non-downgradable;
floor is opus regardless of budget).
