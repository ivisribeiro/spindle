# orchestration-tiers

*How much orchestration the whole task deserves* — orthogonal to the per-agent
model tier. Asked via `spin tier`. Added as the cost-discipline lesson of the
session (improvement I6).

## The tiers
| Tier | When | Orchestration |
|---|---|---|
| **T0** | rename, config, one doc from a result, a lookup | main loop, **0 agents** |
| **T1** | one analysis/file/review; OR planning/audit of a project whose context I already hold | **one agent** (or main-loop draft); no fan-out; at most one adversary |
| **T2** | architecture, security-critical, irreversible, or broad discovery across unfamiliar material | **fan-out** with shared context; adversary on critical items only; budget cap |

## The re-derivation rule (load-bearing)
Fan-out is for **discovery** — material you do not yet hold. If the source is a
backlog doc, or the context is already in hand, the task is **re-derivation, not
discovery → T1**. Never spawn N agents to re-read the same large docs.

`spin tier --have-context --breadth many` returns **T1**, not T2.

## Why it exists
One session spent ~8.8M tokens, much of it firing fan-outs + adversaries at tasks
the main loop would have done. The expensive mistake is treating a T0/T1 task as
T2. "Ultra" modes mean *be thorough where it matters* — not "fan out on everything".
