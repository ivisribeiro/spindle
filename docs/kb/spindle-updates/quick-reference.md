# spindle-updates — quick reference

The changes shipped this session, at a glance.

## Commands added
| Command | Does |
|---|---|
| `spin tier [--risk\|--breadth\|--have-context\|--mechanical\|--reversible]` | classify a task into orchestration tier T0/T1/T2 |
| `spin reconcile --audit f.json` | doc-vs-code drift over an audit handoff (exit 1 on drift) |
| `spin config-drift --declared a,b --present a` | tool in CI but absent from the lockfile |

## Gates added
| Gate | Blocks when |
|---|---|
| `G_AUDIT` | empty audit / built item without evidence / gap without priority |
| `G_OPS_CONFIG` | an `opsReadiness` flag is coded but `enforced: false` in prod |
| `G_PLAN` | vague-acceptance task / L-XL multi-domain bundle / orphan blocking gap |

## Schemas / handoffs added
- `brownfield` schema: `audit → define → design`.
- `audit` handoff: structured `built`/`gaps`/`opsReadiness`/`proposedTasks`/`invariants_at_risk`.
- `/audit` command: parallel fan-out by domain.

## The orchestration tiers (cost discipline)
- **T0** main loop · **T1** one agent / held-context draft · **T2** fan-out + selective adversary.
- Rule: fan-out is for discovery, not re-deriving what you already hold.

## Numbers
93 → **189 tests** · 94% coverage · 11 gates · 65 agents · all green, CI passing.
