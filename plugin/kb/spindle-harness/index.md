# spindle-harness

The Spindle harness architecture: the deterministic spine (`src/`) and the model
layer (`plugin/`) separated by a single process boundary. Every other concept in
this domain flows from that split.

## Concepts

| Slug | What it covers |
|------|----------------|
| [hard-seam](concept-hard-seam.md) | The process boundary that separates `src/` from `plugin/`, what can cross it and how |
| [gate-catalog](concept-gate-catalog.md) | Every gate id, the predicate it enforces, and which phase it guards |
| [handoff-abi](concept-handoff-abi.md) | The typed JSON sidecar contract between workers and `spin complete` |
| [exit-code-abi](concept-exit-code-abi.md) | The four exit codes every `spin` subcommand obeys and what commands must do for each |
| [model-routing](concept-model-routing.md) | How `spin route` maps task kinds to Haiku/Sonnet/Opus and the orchestration T0/T1/T2 axis |
| [run-ledger](concept-run-ledger.md) | `.spindle/run.json`: what it stores, who writes it, and how `spin trace` / `spin budget` read it |

## Quick reference

See [quick-reference.md](quick-reference.md) for a condensed lookup table of
gate ids, handoff ids, exit codes, route kinds, and ledger fields.

## When to consult this domain

- Writing or reviewing a slash command (must follow the harness protocol in §7 of CLAUDE.md)
- Adding a gate, handoff schema, or route kind (must use only ids from the closed sets)
- Debugging a gate block (`spin gate <id>` exits 1)
- Routing a new worker to the correct model tier
- Interpreting `spin trace` output or token accounting
