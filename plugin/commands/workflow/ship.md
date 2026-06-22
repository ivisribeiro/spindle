---
name: ship
description: Phase 4 — gate G_BUILD, diff criteria, gate G_SHIP, dispatch ship-worker (haiku), archive SHIPPED.md + lessons, complete.
---

Run the ship phase for the current feature.

## Steps

### 1. Gate G_BUILD

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_BUILD
```

Exit 1 → STOP. Surface `reasons` and `unmet` to the user. Do not proceed until G_BUILD passes.

Exit 0 → continue.

### 2. Diff criteria (define vs build)

`diff-criteria` reads the JSON **handoff sidecars** (not the markdown artifacts).
`spin complete` stored them at `.handoffs/<artifact-id>.json`, so use `define.json`
and `build.json`:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js diff-criteria \
  --define .spindle/features/<feature>/.handoffs/define.json \
  --build  .spindle/features/<feature>/.handoffs/build.json
```

If `unmet[]` is non-empty → surface the unmet criteria to the user and STOP. Do not proceed to G_SHIP.

### 3. Gate G_SHIP

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_SHIP
```

Exit 1 → STOP. Surface `reasons` and `unmet`.
- `unmet` contains `approval` → a human has not signed off. **You (the agent) cannot
  approve.** Tell the user to run `spin approve` themselves in their terminal, then re-run
  `/ship`. `spin approve` refuses outside an interactive TTY, so this step is the human's.
- Otherwise the define.criteria minus build.passed set is non-empty — the build did not
  satisfy all acceptance criteria. Report which criteria are unmet and halt.

Exit 0 → continue. **Note:** G_SHIP passes even when the build flagged a
`corrected_spec` drift, but it appends a `⚠ … CORRECTED …` line to `reasons`.
If you see one, the spec and the implementation disagreed and the build was
right — DEFINE.md is now stale.

### 3b. Spec-drift — reconcile a corrected spec

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js spec-drift --build .spindle/features/<feature>/.handoffs/build.json
```

Exit 0 → no drift; continue. Exit 1 → the build CORRECTED one or more criteria
(`drifted[]` lists each with its `correction`). To reconcile:

1. **Update the DEFINE.md criterion** to the correct value so the shipped spec is true.
2. **Mark it reconciled** — set `"reconciled": true` on that criterion's result in
   `.spindle/features/<feature>/.handoffs/build.json` (this is the acknowledgment;
   updating DEFINE.md alone does NOT clear the flag — the drift signal lives in the
   build report).
3. **Re-run** `spin spec-drift --build …` — it now exits 0 (the reconciled correction
   is acknowledged) and the loop converges.

A feature must not ship with an unreconciled spec its own build contradicts.

### 4. Route the ship worker

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route ship-prose
```

Model routing will return haiku for `ship-prose` (mechanical, gate-backstopped). Use the returned `model`.

### 5. Dispatch ship worker (haiku)

Dispatch ONE worker via the Task tool on the model returned above. Pass it:

- The feature slug
- The path to the DEFINE artifact
- The path to the BUILD_REPORT artifact
- Instructions:

  > Read DEFINE.md and BUILD_REPORT.md for this feature.
  > Produce TWO artifacts:
  >
  > 1. `.spindle/features/<feature>/SHIPPED.md` — an archive document with sections:
  >    ## Summary, ## Criteria Met, ## Artifacts, ## Run Log
  >    Prose only. Do not invent data not present in the build report.
  >
  > 2. `.spindle/features/<feature>/LESSONS.md` — prose-only retrospective with sections:
  >    ## What Worked, ## What Was Hard, ## Carry Forward
  >    Derive only from the build report and gate outcomes. No speculation.

### 6. Complete the ship artifact

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js complete ship
```

Report to the user: feature is SHIPPED. Cite the paths of SHIPPED.md and LESSONS.md.
