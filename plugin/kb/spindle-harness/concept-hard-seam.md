# Hard Seam

## Summary

The hard seam is the single process boundary that separates the deterministic
spine (`src/` compiled to `dist/cli/index.js`) from the model layer (`plugin/`).
Every ordering, validation, gate, and routing decision crosses the seam as a
child process invocation and an exit code. There is no shared memory, no
callback, and no model handle passed across.

## Definition

The seam is defined structurally: `src/` and `schemas/` are the deterministic
side; `plugin/` is the model side. The crossing mechanism is:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>
```

A command reads stdout (JSON) for detail and the exit code for the branching
decision. The only dispatch path from a command to a worker is the Task tool.

**Model side (`plugin/`):**
- Commands (`plugin/commands/`) — reason, dispatch workers via Task
- Worker agents (`plugin/agents/`) — author one `.md` artifact + one `.json`
  handoff sidecar

**Deterministic side (`src/` → `dist/`):**
- `spin next` / `spin order` — build order (Kahn topological sort)
- `spin complete` / `spin validate` — schema + structure checks
- `spin gate <id>` — phase gates (pure predicates over filesystem + run-state)
- `spin route <kind>` — model routing (pure table lookup)

## Key Properties

- **No model in `src/`**: The guard test (`test/e2e/guard.test.ts`, also
  `scripts/guard-no-model-calls.js`) scans `src/` for inference endpoints, SDK
  imports, `fetch(`, and tokenizer/pricing libraries. A hit fails `npm test`.
- **No hand-mutation of the ledger**: Only `spin` writes `.spindle/run.json`.
  A worker that edits `run.json` directly corrupts the determinism guarantee.
- **No worker advances a phase**: Workers author artifacts; only a passing
  `spin gate` advances a phase. A worker calling `spin complete` by inspecting
  its own output would still require the gate to pass before the phase advances.
- **No invented subcommands**: The `spin` surface in CLAUDE.md §4 is the whole
  surface. Inventing a flag or subcommand in a command is a usage error (exit 2)
  when executed.

## Relationships

- Exit-code ABI (concept-exit-code-abi.md) — the crossing protocol
- Gate catalog (concept-gate-catalog.md) — what gates enforce on the deterministic side
- Handoff ABI (concept-handoff-abi.md) — how workers communicate results back
- Run ledger (concept-run-ledger.md) — the ledger the seam protects

## Examples

A command calling a gate and branching on the result:

```bash
spin gate G_DEFINE
# exit 0 → proceed to dispatch design worker
# exit 1 → STOP, surface {gate, passed, reasons, unmet}, do not advance
```

A command dispatching a worker:

```
Task tool → kb-concept-worker with inputs: FEATURE, CONCEPT, SCHEMA_PATH, ARTIFACT_ID
(The model side of the seam. Worker authors concept-<slug>.md + kb-concept sidecar.)
```

## Test Cases

1. Any `src/` TypeScript file that imports `@anthropic-ai/*`, calls `fetch()`,
   or references `api.anthropic.com` must cause `npm test` to fail via the guard.
2. A worker that writes to `.spindle/run.json` directly (bypassing `spin`) will
   cause the next `spin` invocation that reads the ledger to either fail
   validation (Zod rejects the malformed state) or silently diverge from
   authoritative state.
