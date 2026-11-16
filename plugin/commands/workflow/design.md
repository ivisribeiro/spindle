---
name: design
description: Phase 2 workflow command. Gates on G_DEFINE, dispatches an Opus design-worker, collects DESIGN.md + design handoff, gates on G_DESIGN, then directs to /build.
---

# /design

Run from the project root with the CLI bundled in the plugin. Continue on
exit 0, handle blocks on exit 1, fix invocation errors on exit 2, and stop for
diagnosis on exit 3.

## Protocol

### 1. Gate G_DEFINE (must pass before designing)

```bash
spin gate G_DEFINE
```

Exit 1 → surface `{gate, passed, reasons, unmet}` and STOP. Resolve a recorded DEFINE error through `/iterate` before resuming.

### 2. Determine the ready artifact

```bash
spin next
```

Use the returned `feature` as the slug and require `design` in `ready[]`.
If Design is already recorded in `spin state`, run `spin gate G_DESIGN` to
report its status. Use `/iterate` for changes. For other blocks, report
`blocked` and `gate_blocked`.

### 3. Route the design worker

```bash
spin route design-intent
```

Use the returned `{ tier, model, reason }`. The `design-intent` task kind is a critical kind — it never downgrades even under `--budget low`. Dispatch on the model returned (expected: `opus`).

### 4. Dispatch the design worker (Task tool — single message)

Spawn one worker subagent with the model from step 3. The worker must:

1. Read `.spindle/features/<feature>/DEFINE.md` fully.
2. Read `.spindle/schema.yaml` to understand artifact expectations.
3. Author `.spindle/features/<feature>/DESIGN.md` with **exactly** these top-level sections:
   - `## Overview` — narrative of the approach, key constraints, and rationale.
   - `## File Manifest` — a markdown table with columns `| File | Action | Purpose |` listing every file the build phase will create or modify. The bundled Build gate checks file existence for every manifest path. If this design requires deletions, surface that limitation before finalizing the phase.
   - `## Decisions` — numbered list of non-obvious architectural or implementation decisions with rationale.
4. Write a JSON handoff sidecar to `.spindle/features/<feature>/.handoffs/design.json` matching the `design` handoff schema:

```json
{
  "feature": "<slug>",
  "manifest": [
    { "file": "<path>", "action": "create", "purpose": "<one sentence>" }
  ],
  "decisions": [
    "<decision text>"
  ]
}
```

The worker must not proceed to any implementation. Design artifacts only.

### 5. Validate and complete the design artifact

```bash
spin validate design
```

Run completion only after structural validation returns exit 0.

```bash
spin complete design --handoff .spindle/features/<feature>/.handoffs/design.json
```

**Exit 1** from structural validation or invalid handoff → check and record a bounded retry:

```bash
spin retry design --ok
spin retry design --inc
```

Increment only if the check passes. When both calls pass, re-dispatch the worker with the returned errors and repeat validation. At the ceiling, stop and report the unresolved errors.

**Exit 0** → DESIGN is complete. Continue.

### 6. Gate G_DESIGN (must pass before /build)

```bash
spin gate G_DESIGN
```

Exit 1 → surface `{gate, passed, reasons, unmet}` and STOP. Use `/iterate` for repairs to the recorded artifact or its handoff.

Exit 0 → proceed.

### 7. Hand off to /build

Confirm the gate passed, then output:

```
Design phase complete. Gate G_DESIGN passed.
DESIGN.md and design handoff are valid.

Run /build to begin implementation.
```

Do not start implementing. Do not call `spin next` beyond confirming the DESIGN artifact is the one in play. Control passes to `/build`.

## Constraints

- Never invent `spin` flags or gate IDs not listed in the authoring context.
- Never mark an artifact complete without `spin complete --handoff`.
- Never auto-advance past a failing gate.
- The design worker writes DESIGN.md and the JSON sidecar — no code, no implementation files.
- `design-intent` is a critical routing kind: never downgrade the model regardless of budget flag.
