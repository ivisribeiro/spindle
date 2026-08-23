---
name: define
description: Phase 1 — dispatch define-worker (opus) to produce DEFINE.md + define handoff sidecar, validate, run G_DEFINE gate, and recommend /design on pass.
---

## /define

Phase 1 of the SDD workflow. Produces the **DEFINE.md** artifact (Why / What / Acceptance Criteria with `AC-n` ids) and a **define handoff sidecar**, then validates both and runs `G_DEFINE` before recommending `/design`.

---

### Step 1 — check readiness

```bash
spin next
```

Parse the JSON response. If `complete: true` or the `ready` array does not contain the `define` artifact, surface the blocked state to the user and stop.

---

### Step 2 — route the worker

```bash
spin route define-intent
```

The response returns `{ tier: "opus", model, reason }`. The define phase uses the `define-intent` task-kind, which is a critical kind and **never downgrades** even under `--budget low`.

---

### Step 3 — dispatch define-worker (opus)

Dispatch a single Task on the model returned by `spin route define-intent`. Pass the feature slug and the path to `.spindle/schema.yaml`.

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
spin validate .spindle/features/<feature>/DEFINE.md
```

The JSON carries two **advisory** fields alongside the verdict. Neither changes the exit code — read them, do not branch on them:

- `coverage` — the deterministic discovery score (`readiness`, `coverage`, `decision_clarity`, `covered[]`, `uncovered[]`). Computed by the spine from DEFINE.md plus the handoff, so unlike the handoff's own `clarity` field it is not the worker's opinion of its own work.
- `warnings[]` — dangling cross-references ("as described above" resolves to nothing for a worker reading this artifact alone) and reference tokens that are not real URLs.

Surface `readiness` and any `uncovered[]` blocks to the user before moving on. A low score is not a failure here — it is the honest read on how much of the problem space DEFINE actually touched, and the user decides whether that is enough.

If exit code is `1`, the artifact has structural issues (missing sections, malformed `AC-n` ids). Enter the bounded fix loop:

```bash
spin retry define --inc
```

- If `--inc` exits `0`: re-dispatch the define-worker (return to Step 3).
- If `--inc` exits `1` (ceiling reached): call `spin retry define --ok` and **stop**. Surface the validation errors and the retry ceiling to the user.

---

### Step 5 — mark complete with handoff

```bash
spin complete define --handoff .spindle/features/<feature>/.handoffs/define.json
```

If exit code is `1`, the handoff JSON is invalid (schema mismatch or missing fields). Enter the bounded fix loop (same as Step 4): `spin retry define --inc` → re-dispatch worker → retry complete; stop at ceiling with `spin retry define --ok`.

---

### Step 6 — run G_DEFINE gate

```bash
spin gate G_DEFINE
```

**exit 1 — BLOCKED:** Surface `reasons` and `unmet` to the user. Do **not** advance to `/design`. The user must resolve the blockers (edit DEFINE.md or the handoff sidecar) and re-run `/define`.

Three unmet shapes are worth translating for the user rather than echoing raw:

- `placeholder-criterion:<token>` — an acceptance criterion is still a stub (`AC-1: TBD`). Always enforced: an unwritten criterion cannot be diffed at `G_BUILD`, so it would surface as a phantom pass later. Re-dispatch the worker to write the real criterion.
- `coverage-floor` + `coverage-block:<id>` — only when the schema sets `config.coverage_floor`. The DEFINE does not discuss enough of the discovery blocks named in the `coverage-block:` entries. Fix by writing the missing dimensions, never by lowering the floor mid-run.
- `clarity-floor` — only when the schema sets `config.clarity_floor`; this one reads the worker's self-reported number.

**exit 0 — PASS:** Proceed to Step 7.

---

### Step 7 — recommend /design

Inform the user:

> G_DEFINE passed. DEFINE.md and the define handoff are valid.
> Run **/design** to continue to Phase 2.
