---
name: model-routing
description: Model-routing doctrine for the spindle — when to pick Haiku, Sonnet, or Opus for a task kind, the two hard rules that protect critical gates, and how to ask the CLI for the tier via `spin route`. Use when a workflow command needs to choose the model for a worker subagent, when adding a new task-kind, or when a `--budget low` run wants to downgrade a tier safely.
---

# Model routing

`spin` never calls a model. The slash commands do — and every worker they fan out
runs on a tier (Haiku / Sonnet / Opus). This skill is the doctrine for picking
that tier. The authoritative answer for any task kind comes from the CLI, not
from guessing:

```
spin route <taskKind> [--budget std|low]
```

It returns `{ tier, model, reason }`. Prefer this over hardcoding a model name —
the routing table is owned by the deterministic core, and `spin route` is what the
harness protocol calls in step 2 when a worker's model hint is absent.

## Two axes: orchestration tier vs model tier

There are **two** routing decisions, and they are independent:

1. **Orchestration tier (T0/T1/T2)** — *how much orchestration the whole task
   deserves.* Main loop, one agent, or a fan-out with an adversary. Decide this
   **first**, before spawning anything. Ask the CLI: `spin tier`.
2. **Model tier (Haiku/Sonnet/Opus)** — *which model a given agent runs on.* Only
   relevant once you have decided to spawn an agent. Ask: `spin route <kind>`.

The expensive mistake is treating a T0/T1 task as T2 — firing a multi-agent
fan-out + adversary at something the main loop or a single pass would have done.

```
spin tier [--risk low|medium|high] [--breadth single|few|many] \
          [--have-context] [--mechanical] [--reversible|--irreversible]
# -> { decision: { tier, orchestration, agents, adversary, budgetCap, reason } }
```

| Tier | When | Orchestration |
|---|---|---|
| **T0** | rename, config, one doc from an existing result, a lookup, mechanical edit | main loop — **0 agents**, no adversary |
| **T1** | one analysis/file/review; OR planning/audit of a project whose context I already hold | **one agent** (cheapest model that works); draft in the main loop if context is held; no fan-out; at most one adversary if the output is consequential |
| **T2** | architecture, security-critical, irreversible, or broad discovery across unfamiliar material | **fan-out** for discovery with SHARED context; adversary on **critical items only**; **budget cap required** |

**The re-derivation rule (load-bearing).** Fan-out is for **discovery** — covering
material you do *not* yet hold. If the source is already a backlog/state doc, or
the context is already in hand, the task is **re-derivation, not discovery → T1**.
Never spawn N agents to re-read the same large docs. (Real miss: ~1.2M tokens /
6 auditors to plan a project whose backlog doc already held the answer and whose
context was already in memory — the right size was ~250k, one draft + one
adversary.) `spin tier --have-context --breadth many` returns **T1**, not T2.

**Selective adversary.** Even at T2, the adversary runs on the *critical* items,
not uniformly on every artifact. Passing an Opus adversary over a trivial template
port is waste. (Real miss: an adversary on each of 33 files, several trivial.)

**"Ultra" modes are opt-in, not default.** An ultra/exhaustive directive means
*be thorough where it matters* — it does **not** mean "fan out on everything".
Still triage by tier; a T0/T1 task stays lean even under an ultra flag.

## The model tier table

Default to the **cheapest tier that VERIFIABLY does the task**. A tier is cheap
enough when a deterministic gate (or the handoff schema check inside
`spin complete --handoff`) can catch a bad output — the model does not have to be
trusted, it has to be checkable.

| Tier | Use for | Task kinds (`spin route <kind>`) |
|---|---|---|
| **Haiku** | Mechanical work fully backstopped by a gate or schema check | `file-read`, `structure-extract`, `frontmatter-parse`, `template-fill`, `format-convert`, `claim-extract`, `ship-prose`, `section-scan`, `router-assemble` |
| **Sonnet** | Analysis & authoring — real judgment, but not the final word on a CRITICAL gate | `spec-authoring`, `design-synthesis`, `code-build`, `kb-concept`, `finding-analysis`, `claim-verify`, `migration-plan`, `merge` |
| **Opus** | Deepest reasoning and anything adversarial / final-judge | `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge`, `equivalence-break` |

## The two hard rules

These are non-negotiable. They exist because a wrong call on a CRITICAL gate
ships a defect that no later step catches.

### Rule A — the verifier outranks the generator on critical gates

On any CRITICAL gate, the tier that **judges** must be **>= the tier that
generated** the thing being judged. Never let a cheaper model be the final arbiter
of a CRITICAL finding.

- If Sonnet authored the spec (`spec-authoring`), the adversary that can BLOCK it
  runs on Opus (`adversary` / `review-judge`) — not Sonnet.
- `G_REVIEW_BLOCK` blocks when surviving CRITICAL findings > 0. The model deciding
  whether a finding *survives* is the verifier, so it is Opus-tier.
- A generator may never review its own output as the gate's final judge.

### Rule B — downgrade only behind a gate

Under `--budget low` you may drop a tier **only where a deterministic gate
backstops the output**. The gate, not the model, is what guarantees correctness;
the cheaper model just has to be checkable.

- `spin route code-build --budget low` drops Sonnet → Haiku because `G_BUILD`
  re-checks every manifest file on disk and the criteria-diff; the cheaper model
  only has to be checkable. The same gate-backstopped Sonnet → Haiku drop applies
  to `kb-concept` (backstopped by `G_KB_COVERAGE`) and `merge`. These are the only
  kinds that actually move under `--budget low`.
- A kind already at its floor does NOT drop — there is no cheaper tier to fall to.
  `template-fill` is natively Haiku (its floor), so `spin route template-fill
  --budget low` still returns Haiku; the budget flag changes nothing.
- The **critical kinds NEVER downgrade**, regardless of budget:
  `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge`,
  `equivalence-break`. `spin route adversary --budget low` still returns Opus.

If no gate guards a kind (or it is already at its floor), `--budget low` leaves
its tier unchanged.

## Concrete examples

Ask the CLI; branch on what it returns.

```bash
# Authoring the DEFINE spec — Sonnet, gated downstream by G_DEFINE.
spin route spec-authoring
# -> { tier: "sonnet", model: "...", reason: "analysis/authoring" }

# Per-file build under a tight budget — Sonnet DROPS to Haiku, because G_BUILD
# re-checks every manifest file on disk + the criteria-diff (Rule B in action).
spin route code-build --budget low
# -> { tier: "haiku", ... }   # downgraded sonnet -> haiku (floor=haiku, G_BUILD backstops)

# Same build kind at the standard budget — stays Sonnet.
spin route code-build
# -> { tier: "sonnet", ... }

# The adversary that can fire G_REVIEW_BLOCK — Opus, and stays Opus on low budget
# (Rule A: verifier >= generator on a CRITICAL gate; Rule B: critical never downgrades).
spin route adversary --budget low
# -> { tier: "opus", ... }   # NOT downgraded

# A structure scan that feeds G_DESIGN's manifest check — Haiku is safe because
# the gate re-validates the table deterministically. Already at its Haiku floor,
# so --budget low leaves it unchanged (nothing cheaper to drop to).
spin route section-scan --budget low
# -> { tier: "haiku", ... }

# Final design intent — Opus, never downgraded.
spin route design-intent --budget low
# -> { tier: "opus", ... }
```

### How this slots into the harness protocol

When a workflow command processes a ready artifact:

1. `spin next` reports the ready artifact(s) and a `model` hint.
2. If you need the tier explicitly (or are overriding for budget), call
   `spin route <kind> [--budget low]` and dispatch the worker via Task on that
   model. Artifacts in the same `parallel_group` fan out in one message.
3. The worker writes its markdown artifact **and** a JSON handoff sidecar.
4. `spin complete <id> --handoff <sidecar>` validates the handoff (`G_HANDOFF`).
   Exit 1 → re-dispatch, bounded by `spin retry <id> --inc` (stop at `--ok`).
5. Run the phase gate — `G_DEFINE`, `G_DESIGN`, `G_BUILD`, `G_SHIP`,
   `G_REVIEW_BLOCK`, etc. Exit 1 → STOP and surface `{reasons, unmet}`.

The gate at step 5 is precisely what licenses a Haiku/Sonnet choice at step 2:
the cheap tier is only acceptable because the gate will catch it if it is wrong.

## Adding a new task-kind

1. Decide its tier by the table above — cheapest tier a gate or handoff schema can
   verify.
2. If it can ever be the **final judge** of a CRITICAL gate, it is Opus and must
   honor Rule A.
3. If `--budget low` should downgrade it, confirm a deterministic gate backstops
   it (Rule B); otherwise leave it pinned.
4. Wire it into the routing table so `spin route <kind>` answers, and ensure
   `G_ROUTER_COVERAGE` still sees a clean agent→routing bijection (no silent
   skips).

> Adapted from the ECC model-selection doctrine (Haiku ≈ 90% of Sonnet at lower
> cost for high-frequency mechanical work; Sonnet for core authoring/analysis;
> Opus for deepest reasoning and adversarial review). The harness makes it
> enforceable by binding the cheap tiers to deterministic gates.
