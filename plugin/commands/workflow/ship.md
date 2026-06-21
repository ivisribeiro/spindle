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

Exit 1 → STOP. Surface `reasons` and `unmet`. The define.criteria minus build.passed set is non-empty — the build did not satisfy all acceptance criteria. Report which criteria are unmet and halt.

Exit 0 → continue.

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
