# model-routing

Which model tier (Haiku / Sonnet / Opus) a given worker agent runs on. Asked via
`spin route <taskKind> [--budget std|low]`, which returns `{ tier, model, reason }`.

## The doctrine
Default to the **cheapest tier that verifiably does the task** — a tier is cheap
enough when a deterministic gate (or the handoff schema check) can catch a bad
output. The model does not have to be trusted, it has to be checkable.

| Tier | For |
|---|---|
| **Haiku** | mechanical, gate-backstopped (extract, parse, template-fill) |
| **Sonnet** | analysis & authoring (spec, code-build, migration-plan) |
| **Opus** | deepest reasoning + adversarial (architect, adversary, review-judge) |

## Two hard rules (enforced in `policy.test.ts`)
- **Verifier outranks generator** on any CRITICAL gate — a cheaper tier is never
  the final judge of a CRITICAL finding.
- **Downgrade only behind a gate** — `--budget low` drops Sonnet→Haiku only where
  a gate backstops it. Critical kinds (`adversary`, `architect`, `*-intent`) never
  downgrade: `spin route adversary --budget low` stays Opus.

This is a different axis from the orchestration tier (see `orchestration-tiers`).
