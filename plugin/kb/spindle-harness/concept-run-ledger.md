# Run Ledger

## Summary

The run ledger is `.spindle/run.json`, the single source of truth for a feature
run's state. It is written exclusively by the `spin` CLI via atomic
rename-on-POSIX writes. No command, worker, or model touches it directly. Its
Zod schema (`RunStateSchema` in `src/core/run/run-state.schema.ts`) rejects any
malformed write before it reaches disk.

## Definition

Schema fields (`RunStateSchema`):

| Field | Type | Description |
|-------|------|-------------|
| `version` | literal `1` | schema version |
| `schema` | string | active schema name (`"sdd"` or `"kb"`) |
| `feature` | string | active feature slug |
| `completed` | `string[]` | sorted artifact ids marked done |
| `retries` | `Record<string, number>` | retry counter per artifact id |
| `gates` | `Record<string, GateRecord>` | latest verdict per gate id (`{passed, at, reasons[]}`) |
| `events` | `RunEvent[]` | append-only trajectory (see below) |
| `createdAt` | ISO string | |
| `updatedAt` | ISO string | updated on every mutation |

**Event kinds** (`RunEvent` discriminated union):

- `complete` — `{kind, at, id, usage?}`: artifact marked done. `usage` is
  opaque and model-reported: `{tier?, model?, tokens_in?, tokens_out?}`. The CLI
  records it as-is; it never computes, tokenizes, or prices token numbers (the
  guard test forbids it).
- `gate` — `{kind, at, gate, passed, reasons[]}`: gate verdict. Only appended
  when the verdict CHANGES from the last recorded verdict for that gate id, so
  re-running an unchanged gate is idempotent on the ledger.
- `retry` — `{kind, at, id, attempt}`: retry counter bump. Every increment is
  its own event.

**Two distinct views of state:**
- `completed[]` / `retries{}` / `gates{}` — the current state maps (latest
  snapshot per id).
- `events[]` — the trajectory (every transition). `spin trace` reads this;
  `spin budget` summarizes tier/token usage from `complete` events.

**Atomicity**: writes go to a temp file (`.<name>.tmp-<pid>`) then `rename()`,
which is atomic on POSIX. A crash mid-write leaves a `.tmp` file, not a corrupt
`run.json`.

## Key Properties

- **CLI-written only**: `markComplete`, `incRetry`, `recordGate`,
  `initRunState`, `saveRunState` in `src/core/run/run-state.ts` are the only
  write paths. Any other writer is a correctness violation.
- **Validation on every write**: `saveRunState` calls `RunStateSchema.safeParse`
  before the atomic write. A malformed state is rejected with an error, never
  persisted.
- **`spin trace` is advisory**: it reads `events[]` and produces a
  tier/token summary. Exit 0 always. Token numbers are model-reported and
  unverified by the CLI — `spin trace` accounts, it does not enforce.
- **`spin budget` is advisory**: reconciles model-reported token spend vs an
  optional `--max-tokens` ceiling. Advisory means always exit 0, even at
  ceiling. Use it for planning, not for blocking.
- **`spin state`** prints the current `run.json` as JSON, exit 0. A read-only
  subcommand for commands to inspect current state without mutation.
- **Gate trajectory deduplication**: `recordGate` appends a `gate` event only
  when `passed` or `reasons` differ from the last event for that gate. This
  prevents the ledger from growing unboundedly on repeated gate re-runs.

## Relationships

- Hard seam (concept-hard-seam.md) — the ledger is what the seam protects; only
  the deterministic side writes it
- Gate catalog (concept-gate-catalog.md) — gates write their verdicts into
  `gates{}` and `events[]` via `recordGate`
- Exit-code ABI (concept-exit-code-abi.md) — `spin complete` exits 1 when a
  handoff fails, keeping the artifact out of `completed[]`
- Model routing (concept-model-routing.md) — model-reported usage is stored in
  `complete` events; the CLI never interprets the numbers

## Examples

After a full SDD cycle that blocked `G_BUILD` once then passed:

```json
{
  "version": 1,
  "schema": "sdd",
  "feature": "auth-gate",
  "completed": ["build", "define", "design"],
  "retries": { "build": 1 },
  "gates": {
    "G_DEFINE": { "passed": true, "at": "2026-06-22T10:00:00Z", "reasons": ["define complete"] },
    "G_DESIGN": { "passed": true, "at": "2026-06-22T10:05:00Z", "reasons": ["design complete"] },
    "G_BUILD": { "passed": true, "at": "2026-06-22T10:15:00Z", "reasons": ["build verified"] }
  },
  "events": [
    { "kind": "complete", "at": "2026-06-22T10:00:00Z", "id": "define", "usage": { "tier": "opus", "tokens_in": 1200, "tokens_out": 800 } },
    { "kind": "gate", "at": "2026-06-22T10:00:00Z", "gate": "G_DEFINE", "passed": true, "reasons": ["define complete"] },
    { "kind": "complete", "at": "2026-06-22T10:05:00Z", "id": "design" },
    { "kind": "gate", "at": "2026-06-22T10:05:00Z", "gate": "G_DESIGN", "passed": true, "reasons": ["design complete"] },
    { "kind": "retry", "at": "2026-06-22T10:10:00Z", "id": "build", "attempt": 1 },
    { "kind": "gate", "at": "2026-06-22T10:10:00Z", "gate": "G_BUILD", "passed": false, "reasons": ["manifest file not built: src/auth/gate.ts"] },
    { "kind": "complete", "at": "2026-06-22T10:15:00Z", "id": "build" },
    { "kind": "gate", "at": "2026-06-22T10:15:00Z", "gate": "G_BUILD", "passed": true, "reasons": ["build verified"] }
  ]
}
```

Note: `G_BUILD` appears twice in `events[]` (block then pass) but only once in
`gates{}` (latest verdict). The `retries{}` counter shows the build needed one
re-dispatch.

## Test Cases

1. Calling `markComplete` twice with the same artifact id must produce exactly
   one `complete` event in `events[]` (idempotent — the second call is a no-op
   on the trajectory).
2. `recordGate` called twice with the same gate id and identical `passed` /
   `reasons` values must not append a second `gate` event (deduplication
   prevents unbounded ledger growth on repeated re-runs).
