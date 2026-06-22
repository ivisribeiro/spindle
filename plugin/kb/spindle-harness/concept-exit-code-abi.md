# Exit-Code ABI

## Summary

Every `spin` subcommand exits with one of four codes. Commands branch strictly
on the exit code — never on parsed prose from stdout. This contract is the
crossing protocol at the hard seam: it is what lets the deterministic side
communicate domain outcomes (blocked gates, invalid handoffs) to the model side
without any shared state.

## Definition

From CLAUDE.md §2:

| Code | Meaning | Command must |
|------|---------|-------------|
| `0` | pass | proceed |
| `1` | gate blocked / handoff invalid | STOP; surface `{reasons,unmet}`; retry (bounded) or halt — never advance |
| `2` | usage error (bad args/flags) | fix the invocation — this is a bug in the command, not a gate |
| `3` | internal error | abort; do not retry blindly |

`1` is a domain outcome — the gate did its job. `2` and `3` are bugs. When
adding a subcommand, a blocked gate is `1`, a malformed call is `2`, an
unexpected crash is `3`. Tests assert on the exit code, so returning the wrong
one is a breaking change.

## Key Properties

- **Retry contract for exit 1**: when `spin complete <id> --handoff <f>` exits
  1 (invalid handoff), the command re-dispatches the worker, bounded by `spin
  retry <id> --inc` (increment counter) followed by `spin retry <id> --ok`
  (exits 1 at the ceiling configured in `config.build_retry_cap`). Never mark
  an artifact complete by hand when the handoff fails.
- **Gate blocks are exit 1 regardless of severity**: `G_REVIEW_BLOCK` exits 1
  even if the only finding is `low` severity, because the predicate is
  `surviving CRITICAL > 0`. An exit-0 gate is always the signal to proceed;
  an exit-1 gate always means stop. The severity decision is encoded in the gate
  predicate, not in the exit code.
- **`spin eval --strict` regression detection**: `spin eval` replays the eval
  corpus through the real gates and exits 1 if a verdict regresses. `--strict`
  additionally requires every gate to have at least one passing and one blocking
  fixture. This is a test-suite subcommand, not a live gate.
- **`spin budget`**: always exits 0 (accounting only; token numbers are
  model-reported and the CLI never computes or prices them). Do not use `spin
  budget` as a gate or for enforcement — use it only for reporting.
- **`spin trace`**: always exits 0. A pure read of the `events[]` ledger plus
  a tier/token summary. Not a gate.

## Relationships

- Hard seam (concept-hard-seam.md) — exit codes are the crossing protocol
- Gate catalog (concept-gate-catalog.md) — gates produce exit 0 or 1
- Handoff ABI (concept-handoff-abi.md) — invalid handoffs at `spin complete`
  produce exit 1
- Run ledger (concept-run-ledger.md) — exit-1 gate results are recorded in
  `gates{}` and the `events[]` trajectory

## Examples

Handling an exit-1 at `spin gate G_DESIGN`:

```
spin gate G_DESIGN   → exit 1
stdout: {"gate":"G_DESIGN","passed":false,
          "reasons":["DESIGN has no file-manifest table"],
          "unmet":["manifest-table"]}

Command action:
  1. Surface the reasons and unmet items to the user.
  2. Do NOT dispatch the build worker.
  3. Re-dispatch the design worker to fix the missing table.
  4. Re-run spin gate G_DESIGN.
```

Handling an exit-2 (usage error):

```
spin gate G_NONEXISTENT   → exit 2
stdout: {"error":"unknown gate id \"G_NONEXISTENT\""}

This is a bug in the command, not a gate block. Fix the gate id.
```

## Test Cases

1. `spin gate G_KB_STRUCTURE` against a directory where `index.md` is present
   but `quick-reference.md` is absent must exit 1 (not 0, not 2).
2. `spin gate <invented-id>` must exit 2, not 1 or 3, because an unknown gate
   id is a usage error in the calling command.
