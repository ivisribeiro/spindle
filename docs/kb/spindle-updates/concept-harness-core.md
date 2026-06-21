# harness-core

The deterministic spine of Spindle: the `spin` CLI. It **never calls a model** —
a grep-guard test fails CI if `src/` ever references an inference endpoint.

## What it is
- **Artifact graph** (ported from OpenSpec): Kahn topological sort over a
  `schema.yaml`; `spin next` returns the ready artifacts, `spin order` the full order.
- **Run-state ledger** (`.spindle/run.json`): CLI-written only, crash-safe; gates
  read filesystem + state, never the conversation, so verdicts are idempotent.
- **Handoff validation**: `spin complete <id> --handoff f.json` validates a worker's
  JSON against its Zod schema *before* marking the artifact done.
- **Gates**: pure `(ctx) => GateResult`; `spin gate <id>` maps a block to exit 1
  with `{gate, passed, reasons, unmet}`.

## Exit-code ABI
`0` pass · `1` blocked / handoff invalid · `2` usage · `3` internal.

## Why it matters
The seam is the whole design: deterministic decisions in `spin`, authoring in
commands. You can write a test that asserts the CLI blocked on a missing file;
you cannot assert that an LLM did.
