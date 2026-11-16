---
name: define
description: Phase 1 — dispatch define-worker (opus) to produce DEFINE.md + define handoff sidecar, validate, run G_DEFINE gate, and recommend /design on pass.
---

## /define

Phase 1 of the SDD workflow. Produces the **DEFINE.md** artifact (Why / What / Acceptance Criteria with `AC-n` ids) and a **define handoff sidecar**, then validates both and runs `G_DEFINE` before recommending `/design`.

Run from the project root. Use the CLI bundled with the plugin for every
`spin` command. Continue on exit 0, handle blocks on exit 1, fix invocation
errors on exit 2, and stop for diagnosis on exit 3.

---

### Step 1 — check readiness

```bash
spin next
```

Use the returned `feature` as the slug. Require `define` in `ready[]` before
writing. If Define is already recorded in `spin state`, run `spin gate G_DEFINE`
to report its current status and use `/iterate` for changes. For other blocks,
surface `blocked` or `gate_blocked` and stop.

---

### Step 2 — route the worker

```bash
spin route define-intent
```

The response returns `{ tier: "opus", model, reason }`. The define phase uses the `define-intent` task-kind, which is a critical kind and **never downgrades** even under `--budget low`.

---

### Step 3 — dispatch define-worker (opus)

Dispatch a single Task on the model returned by `spin route define-intent`. Pass the feature slug, the active schema, the user's brief, and any completed
discovery artifact. Address material ambiguities with the user before asking the
worker to turn them into acceptance criteria.

The **define-worker** must:

1. Read `.spindle/schema.yaml` to understand the feature scope and any constraints.
2. Write `.spindle/features/<feature>/DEFINE.md` with exactly these top-level sections:
   - `## Why` — business rationale and problem statement
   - `## What` — scope and solution summary
   - `## Acceptance Criteria` — a numbered list where every item uses the form `AC-n: <criterion>` (e.g. `AC-1:`, `AC-2:`, …)
3. Write `.spindle/features/<feature>/.handoffs/define.json` matching the **define** handoff schema:
   ```json
   {
     "feature": "<slug>",
     "clarity": 0.92,
     "criteria": ["AC-1", "AC-2", "..."]
   }
   ```
   `clarity` is a **0..1 confidence score** (e.g. `0.92` = high confidence, `0.5` = uncertain) — not a string enum.

---

### Step 4 — validate the artifact

```bash
spin validate define
```

The JSON carries two **advisory** fields alongside the verdict. Neither changes the exit code — read them, do not branch on them:

- `coverage` — the deterministic discovery score (`readiness`, `coverage`, `decision_clarity`, `covered[]`, `uncovered[]`). Computed by the spine from DEFINE.md plus the handoff, so unlike the handoff's own `clarity` field it is not the worker's opinion of its own work.
- `warnings[]` — dangling cross-references ("as described above" resolves to nothing for a worker reading this artifact alone) and reference tokens that are not real URLs.

Surface `readiness` and any `uncovered[]` blocks to the user before moving on. A low score is not a failure here — it is the honest read on how much of the problem space DEFINE actually touched, and the user decides whether that is enough.

On exit 1, report the structural errors. Use the same bounded repair for
validation or handoff failures:

```bash
spin retry define --ok
spin retry define --inc
```

Run the increment only if the check passes. Re-dispatch only after both return
exit 0, then repeat validation. At the ceiling, retain the visible errors and
stop.

---

### Step 5 — mark complete with handoff

```bash
spin complete define --handoff .spindle/features/<feature>/.handoffs/define.json
```

On exit 1 from an invalid handoff, use the bounded repair above and revalidate
both outputs. Surface any `unknown_keys` returned by the CLI.

---

### Step 6 — run G_DEFINE gate

```bash
spin gate G_DEFINE
```

**exit 1 — BLOCKED:** Surface `reasons` and `unmet` to the user. Do **not** advance to `/design`. Use `/iterate` to invalidate the recorded Define artifact before editing it or its handoff.

Three unmet shapes are worth translating for the user rather than echoing raw:

- `placeholder-criterion:<token>` — an acceptance criterion is still a stub (`AC-1: TBD`). Write a concrete, testable criterion as part of the repair.
- `coverage-floor` + `coverage-block:<id>` — only when the schema sets `config.coverage_floor`. The DEFINE does not discuss enough of the discovery blocks named in the `coverage-block:` entries. Fix by writing the missing dimensions, never by lowering the floor mid-run.
- `clarity-floor` — only when the schema sets `config.clarity_floor`; this one reads the worker's self-reported number.

**exit 0 — PASS:** Proceed to Step 7.

---

### Step 7 — recommend /design

Inform the user:

> G_DEFINE passed. DEFINE.md and the define handoff are valid.
> Run **/design** to continue to Phase 2.
