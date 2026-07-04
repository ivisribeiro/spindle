# Eval corpus — the harness evaluating itself

`spin eval` replays every case here through the **real** gate function and asserts the
re-computed verdict matches the recorded `expect`. A code change that makes a gate stop
blocking what it used to block is a regression this corpus catches. It is fully
deterministic and offline — no model, no network — so it evaluates the *harness*, not an
LLM.

## Case format

Each case is a directory with a `case.json`:

```json
{
  "id": "G_AUDIT-block",
  "gate": "G_AUDIT",
  "expect": "pass | block",
  "args": { "handoff": "audit.json" },
  "note": "one line on what this case pins down"
}
```

- `args` file paths resolve **relative to the case directory**.
- The case directory **is the gate root**: a state-coupled gate (e.g. `G_DEFINE`) reads a
  `.spindle/` tree placed inside the case dir; an arg-file gate reads the files named in
  `args`. Both work through the same mechanism.

## Coverage (honest, on the record)

The corpus now pins **all 11 registry gates** with at least one pass **and** one block
case each — the arg-file gates (`G_AUDIT`, `G_OPS_CONFIG`, `G_PLAN`, `G_REVIEW_BLOCK`,
`G_ROUTER_COVERAGE`) as standalone fixtures, and the state-coupled gates (`G_DEFINE`,
`G_DESIGN`, `G_BUILD`, `G_SHIP`, `G_KB_STRUCTURE`, `G_KB_COVERAGE`) as frozen `.spindle/`
snapshot dirs, including the `G_SHIP` spec-drift pair (block on unreconciled,
pass on reconciled). `spin eval --strict` fails if any registry gate ever loses its
pass+block pair, so a new gate cannot ship without fixtures. The end-to-end suite
(`test/e2e/sdd-cycle.e2e.test.ts`, `test/e2e/kb-cycle.e2e.test.ts`,
`test/e2e/brownfield-cycle.e2e.test.ts`) exercises the same gates through the live CLI.
