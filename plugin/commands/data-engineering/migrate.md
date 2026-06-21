---
name: migrate
description: Highest-risk REWRITE command. Fans out migrate-dbt-worker + migrate-spark-worker (sonnet) in independent contexts as competing migration-plans, picks the engine from the data, has an independent equivalence-worker verify source/target equivalence, then an Opus adversary attempt an equivalence-break against the chosen plan. Emits findings.json and gates on G_REVIEW_BLOCK before recommending. No single agent both decides and validates.
---

# /migrate

Migrate a legacy ETL pipeline to a modern engine (dbt or Spark) as a controlled
**rewrite**. This is the highest-risk command in the harness: the deliverable is
not code but a **recommended migration plan that has survived adversarial
equivalence review**. Separation of duties is structural — the agent that
authors a plan never validates it, and the agent that verifies equivalence never
authors a plan.

`/migrate` is a **one-shot review flow**, not an SDD/KB phase graph: it does not
`spin init` a run, so there is no run-state, no `spin next/complete/retry`, and no
graph artifact. Its only deterministic checks are `spin handoff-check` (worker
output shape) and `spin gate G_REVIEW_BLOCK` (the correctness gate). Pick any
working directory under `.spindle/migrate/<name>/` for scratch files.

The chain: **two independent plans → engine pick from the data → independent
equivalence verification → adversarial equivalence-break → findings.json →
G_REVIEW_BLOCK → recommend.**

## Inputs

- The legacy pipeline source (SQL/stored procs/scripts), its source and target
  schemas, and representative volume/throughput characteristics. Pass these
  paths to every worker; they decide nothing the data does not support.

## Protocol

### 1. Author TWO competing migration plans — independent contexts, true parallel

Dispatch **migrate-dbt-worker** and **migrate-spark-worker** via the Task tool
**in a single message** so they run in fully independent contexts. Neither sees
the other's output. Each is a *plan author only* — it does not validate, and it
does not see the equivalence or adversary phases.

Route each on `migration-plan` (sonnet — analysis/authoring):

```bash
spin route migration-plan
```

Use the returned `{ tier, model, reason }` (expected: sonnet) for **both**
workers. Then dispatch, in one message:

**Worker A — migrate-dbt-worker (sonnet).** Instruct it:

> Read the legacy pipeline source, source schema, target schema, and the
> volume/throughput profile. Decide whether **dbt** is the right engine for THIS
> data — base the call on the evidence. If the data argues against dbt, say so in
> `risks` and still produce the most honest dbt plan possible. Author
> `.spindle/migrate/<name>/MIGRATION_PLAN_DBT.md`, then write a JSON handoff sidecar
> at `.spindle/migrate/<name>/plan-dbt.json` matching the `migration-plan` schema
> (`rollback` is a single string — see `schemas/handoffs/examples/migration-plan.json`):
>
> ```json
> {
>   "engine": "dbt",
>   "steps": [ "<ordered migration step>" ],
>   "risks": [ "<risk with severity and trigger>" ],
>   "rollback": "<single-string rollback / safe-revert procedure>"
> }
> ```
>
> Do not validate equivalence. Do not run the rewrite. Plan only.

**Worker B — migrate-spark-worker (sonnet).** Same instruction, engine `spark`,
writing `MIGRATION_PLAN_SPARK.md` and `.spindle/migrate/<name>/plan-spark.json` with
`"engine": "spark"`.

### 2. Validate both plan handoffs

```bash
spin handoff-check migration-plan .spindle/migrate/<name>/plan-dbt.json
spin handoff-check migration-plan .spindle/migrate/<name>/plan-spark.json
```

Exit 1 on either → that plan's handoff is the wrong shape. Re-dispatch **only
that worker** (bounded: at most twice; if it still fails, STOP and surface the
`handoff-check` errors). Exit 0 on both → continue.

### 3. Pick the engine from the data

Read both `migration-plan` handoffs. Select the engine whose plan the **evidence
in the data** supports — set-based/warehouse-pushdown transforms favor dbt;
large-volume shuffle/joins, streaming, or non-SQL logic favor Spark. The choice
is a function of the data and the two plans' `risks`, **not** a preference.
Record the chosen and the losing engine; carry the **chosen** plan into review.
The plan authors do not participate in this decision.

### 4. Independent equivalence verification (NOT a plan author)

Dispatch a separate **equivalence-worker** — a different agent from either plan
author, with no authority to amend the plan. Route on `claim-verify` (sonnet):

```bash
spin route claim-verify
```

Instruct it:

> You did not write this plan and you may not change it. Read the chosen
> migration plan and the legacy source. Verify **source/target equivalence**: for
> every legacy output (row grain, column semantics, aggregations, null/empty
> handling, dedup keys, watermark/late-data behavior, type coercions), confirm
> the migrated plan reproduces it. Emit one `finding` handoff sidecar at
> `.spindle/migrate/<name>/equiv-findings.json` matching the `finding` schema —
> a `{ "findings": [ ... ] }` object whose entries use **lowercase** severity:
>
> ```json
> {
>   "findings": [
>     {
>       "file": "<plan file / step>",
>       "line": null,
>       "severity": "critical",
>       "rule": "equivalence",
>       "message": "<equivalence property under test and where source/target diverge>",
>       "source": "equivalence-worker"
>     }
>   ]
> }
> ```
>
> An equivalence break that changes output values, grain, or row count is
> `critical`. If equivalence holds, emit `{ "findings": [] }`. Do not propose
> fixes — report divergences only.

Validate it:

```bash
spin handoff-check finding .spindle/migrate/<name>/equiv-findings.json
```

### 5. Adversarial equivalence-break (Opus)

Dispatch the **adversary / challenger** on the `equivalence-break` task kind — a
critical routing kind that **never downgrades**, even under `--budget low`:

```bash
spin route equivalence-break --budget low
```

Use the returned model (expected: opus). The adversary did not author the plan
and is not the equivalence-worker. Instruct it:

> Assume the chosen migration plan is wrong. Try to **break** source/target
> equivalence: construct concrete inputs (skew, nulls, duplicate keys, late
> records, type overflow, timezone/locale, empty partitions, ordering
> non-determinism) for which the migrated plan diverges from the legacy output.
> Treat the equivalence-worker's PASSes as hypotheses to falsify. Emit a `finding`
> handoff at `.spindle/migrate/<name>/adversary-findings.json` (same `{ "findings": [ ... ] }`
> shape, lowercase severity, `source: "adversary"`). A reproducible divergence in
> output values, grain, or row count is `critical`. Do not soften severity and do
> not patch the plan.

Validate it:

```bash
spin handoff-check finding .spindle/migrate/<name>/adversary-findings.json
```

### 6. Emit findings.json

Concatenate the `findings` arrays from the equivalence-worker (step 4) and the
adversary (step 5) into one `finding` handoff at
`.spindle/migrate/<name>/findings.json`:

```json
{ "findings": [ "<every equiv finding>", "<every adversary finding>" ] }
```

Do not drop, merge, or downgrade any finding. This file is the sole input to the
gate — the agents that produced the findings do not get to clear them.

### 7. Gate G_REVIEW_BLOCK (before any recommendation)

```bash
spin gate G_REVIEW_BLOCK --findings .spindle/migrate/<name>/findings.json
```

`G_REVIEW_BLOCK` blocks when surviving **CRITICAL** findings > 0.

- **Exit 1 → STOP. Do NOT recommend the migration.** Surface
  `{gate, passed, reasons, unmet}` and the CRITICAL findings. Remediation means
  re-authoring the plan (re-run step 1 for the affected engine), not editing
  `findings.json`.
- **Exit 0 → continue.**

### 8. Recommend (only after G_REVIEW_BLOCK passes)

Report to the user (no `spin complete` — there is no run to complete):

- The recommended engine and **why the data chose it** (vs. the rejected engine).
- The remaining HIGH/MEDIUM/LOW findings that survived review (carry-forward risk).
- The plan's `steps`, `risks`, and `rollback`.
- The paths to `MIGRATION_PLAN_<ENGINE>.md` and `findings.json`.

State explicitly that the recommendation cleared G_REVIEW_BLOCK with zero
surviving CRITICAL equivalence breaks.

## Error surfaces

| Condition | Action |
|---|---|
| `spin handoff-check migration-plan` exit 1 (step 2) | Re-dispatch ONLY that plan worker (≤2 times); then STOP and surface the errors. |
| `spin handoff-check finding` exit 1 (step 4/5) | Re-dispatch that reviewer to re-emit the sidecar in the correct `{findings:[...]}` shape (≤2 times); then STOP. |
| Both plans argue against their engine | Surface both `risks` sets; do not force a recommendation. The data may not be migratable as-is. |
| `G_REVIEW_BLOCK` exit 1 (step 7) | STOP. Print `reasons` + surviving CRITICAL findings. Re-author the affected plan (step 1); never edit findings.json to pass the gate. |

## Constraints — separation of duties

- **No single agent both decides and validates.** Plan authors never verify
  equivalence; the equivalence-worker is not a plan author and cannot amend the
  plan; the adversary is neither.
- The engine is **picked from the data**, not chosen by a plan author.
- The **verifier/adversary outranks the generator on the CRITICAL gate**: the
  `equivalence-break` adversary runs on opus and never downgrades. Plan authors
  (sonnet) are never the final judge of a CRITICAL equivalence finding.
- `findings.json` is authored only by aggregation; findings are never dropped,
  merged, or downgraded to clear `G_REVIEW_BLOCK`.
- **No recommendation before `G_REVIEW_BLOCK` passes.** Never auto-advance past a
  failing gate.
- Never invent `spin` flags, gate IDs, task kinds, or handoff schema ids beyond
  those used above (`route`, `handoff-check`, `gate`).
