---
name: ship
description: Phase 4 — gate G_BUILD, diff criteria, gate G_SHIP, dispatch ship-worker (haiku), archive SHIPPED.md + lessons, complete.
---

Run the ship phase for the current feature. This archives the run. Publishing,
merging, and deploying require their own authorization. Use `spin state` to
resolve the active feature. Use the exit code of each invocation. Fix usage errors
(exit 2) and halt on internal errors (exit 3).

## Steps

### 1. Verify the upstream gates

Run each gate in order and continue only on exit 0.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_DEFINE
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_DESIGN
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_BUILD
```

Exit 1 → stop and surface `reasons` and `unmet`.

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

Exit 1 → surface the unmet criteria to the user and STOP. Do not proceed to G_SHIP.

### 2b. Budget enforcement (optional)

Check the active schema for a declared ceiling:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js schema show
```

If `config.max_tokens` is set, run budget with enforcement before G_SHIP:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js budget --enforce
```

Exit 1 → STOP. Surface the reported spend and the ceiling (`max_tokens`,
`ceiling_source`) to the user with the `self_reported` indicator. Resume
after the user resolves the budget block.

Exit 0 → continue. If `config.max_tokens` is unset, skip this step
entirely — `spin budget` without `--enforce` remains purely advisory and is not
required here.

### 3. Diagnose spec drift before requesting approval

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js spec-drift --build .spindle/features/<feature>/.handoffs/build.json
```

Exit 1 → stop shipping. If the handoff is invalid, surface `schema_errors`
and return to Build. If `drifted[]` contains corrected criteria, present each
criterion and its recorded correction to the user. Reconcile through
`/iterate` within the authorized scope. Invalidate `define` before changing
the spec, then re-complete and re-gate the affected phases. Preserve the
correction and set `reconciled: true` in the rebuilt handoff only after the
new DEFINE records the corrected value and the verifier passes against it.
Request fresh approval after those gates pass.

Exit 0 → run the shipping gate.

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_SHIP
```

Exit 1 → stop and surface `reasons` and `unmet`. For missing, stale, or
unbound approval, report the blocker and any changed paths. Reopen changed
work and rerun its verifiers before seeking sign-off. Tell the user to run
`spin approve` in their own interactive terminal and then re-run `/ship`. The assistant never runs approval, including through
a pseudo-terminal.

Exit 0 → run `spin next` and require `ship` in `ready[]` before dispatching.
If the ledger already records Ship, report its status and the existing archive.

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

Check that both archive files reflect the current build report before recording
completion.

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js complete ship
```

Exit 0 → report that the Spindle archive is recorded and cite both artifact
paths. On a blocked completion, surface the CLI details and stop.
