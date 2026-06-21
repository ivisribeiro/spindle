---
name: design
description: Phase 2 workflow command. Gates on G_DEFINE, dispatches an Opus design-worker, collects DESIGN.md + design handoff, gates on G_DESIGN, then directs to /build.
---

# /design

Phase 2 of the SDD workflow. Requires a passing G_DEFINE gate before any design work begins.

## Protocol

### 1. Gate G_DEFINE (must pass before designing)

```bash
spin gate G_DEFINE
```

Exit 1 → surface `{gate, passed, reasons, unmet}` and STOP. Do not proceed until the caller fixes the DEFINE artifact and re-runs `/design`.

### 2. Determine the ready artifact

```bash
spin next
```

Expect `{ ready: [{id, model, parallel_group}], blocked: {}, complete: false }`.  
The design phase has one artifact: `design`. Confirm `id` is `design` and read its `model` hint (should be `opus`).

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
   - `## File Manifest` — a markdown table with columns `| File | Action | Purpose |` listing every file the build phase will create or modify (`action`: `create` or `modify`).
   - `## Decisions` — numbered list of non-obvious architectural or implementation decisions with rationale.
4. Write a JSON handoff sidecar to `.spindle/features/<feature>/.handoffs/design.json` matching the `design` handoff schema:

```json
{
  "feature": "<slug>",
  "manifest": [
    { "file": "<path>", "action": "create|modify|delete", "purpose": "<one sentence>" }
  ],
  "decisions": [
    "<decision text>"
  ]
}
```

The worker must not proceed to any implementation. Design artifacts only.

### 5. Complete the design artifact (validate handoff)

```bash
spin complete design --handoff .spindle/features/<feature>/.handoffs/design.json
```

**Exit 1** → handoff is invalid. Run the bounded-retry loop:

```bash
spin retry design --inc   # increment retry counter
# exit 1 at ceiling -> STOP with error: "design retry ceiling reached"
```

Re-dispatch the worker with the `{reasons, unmet}` from the failed `spin complete` call. Repeat until exit 0 or ceiling.

**Exit 0** → DESIGN is complete. Continue.

### 6. Gate G_DESIGN (must pass before /build)

```bash
spin gate G_DESIGN
```

Exit 1 → surface `{gate, passed, reasons, unmet}` and STOP. Tell the caller which criteria failed and that `/design` must be re-run after fixing the artifact.

Exit 0 → proceed.

### 7. Hand off to /build

Confirm the gate passed, then output:

```
Design phase complete. Gate G_DESIGN passed.
DESIGN.md and design handoff are valid.

Run /build to begin implementation.
```

Do not start implementing. Do not call `spin next` beyond confirming the DESIGN artifact is the one in play. Control passes to `/build`.

## Error surfaces

| Condition | Action |
|---|---|
| G_DEFINE exit 1 | STOP. Print `reasons` + `unmet`. Tell user to fix DEFINE and re-run `/design`. |
| `spin next` shows no ready artifact | STOP. Print `spin state` output. Something in the ledger is inconsistent. |
| `spin complete` exit 1 (invalid handoff) | Retry via `spin retry design --inc`; re-dispatch worker. Stop at ceiling. |
| G_DESIGN exit 1 | STOP. Print `reasons` + `unmet`. Tell user to fix DESIGN.md and re-run `/design`. |

## Constraints

- Never invent `spin` flags or gate IDs not listed in the authoring context.
- Never mark an artifact complete without `spin complete --handoff`.
- Never auto-advance past a failing gate.
- The design worker writes DESIGN.md and the JSON sidecar — no code, no implementation files.
- `design-intent` is a critical routing kind: never downgrade the model regardless of budget flag.
