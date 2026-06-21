---
name: fact-check
description: Pipeline that extracts claims from a document, fans out parallel verification per claim, then runs a parallel correction pass for false/unverifiable claims. spin sequences and validates every claim handoff.
---

# /fact-check

Fact-check a document via a three-stage pipeline:
1. **extract-worker** (haiku) — reads the source and emits a `claim` handoff (`{claims:[{id,text}]}`).
2. **verify-workers** (sonnet, parallel) — one worker per claim, each writes a `claim` handoff (`{claims:[{id,text,verified,verdict,evidence}]}`).
3. **correction pass** (sonnet, parallel) — one verify-worker rerun per flagged claim (`verdict=="false"` or `"unverifiable"`), writing a `claim` handoff with corrected `text` and an `evidence` field describing the correction.

spin owns all sequencing, gate enforcement, and handoff validation. The command never advances past a stage if `spin complete` exits 1.

---

## Setup

Before the first stage, initialise the fact-check artifact graph:

```bash
spin init --schema fact-check --feature fact-check
```

This scaffolds `.spindle/` with a `schema.yaml` defining artifacts `extract`, `verify-<id>`, and `correct-<id>` each bound to handoff type `claim`, so every subsequent `spin complete` and `spin retry` resolves against a real schema.

---

## Usage

```
/fact-check <source-path>
```

| Argument | Required | Description |
|---|---|---|
| `source-path` | yes | Path to the document to fact-check |

---

## Stage 1 — Extract claims (haiku)

```bash
spin route claim-extract
# -> { tier: "haiku", model: "..." }
```

Dispatch **one** `factcheck-extract-worker` Task on the returned model.

**Worker instructions:**

> Read `<source-path>`. Extract every verifiable factual claim. For each claim write:
> - `id`: sequential string (`claim-0`, `claim-1`, …)
> - `text`: verbatim claim text (normalised, no trailing punctuation)
>
> Write the JSON handoff to `.spindle/features/fact-check/.handoffs/extract.json`.
> Schema id: `claim`. Wrap all claims in a top-level `claims` array:
> `{"claims":[{"id":"claim-0","text":"..."},...]}`

After the worker returns:

```bash
spin complete extract --handoff .spindle/features/fact-check/.handoffs/extract.json
```

- Exit 0 → proceed to Stage 2.
- Exit 1 → handoff invalid. Run `spin retry extract --inc`; if that exits 1 (ceiling hit), STOP and surface the error. Otherwise re-dispatch the extract-worker.

---

## Stage 2 — Verify claims in parallel (sonnet)

Read the validated claim array from `.spindle/features/fact-check/.handoffs/extract.json`.

```bash
spin route claim-verify
# -> { tier: "sonnet", model: "..." }
```

Fan out **all claims in a single message** — one `factcheck-verify-worker` Task per claim, all dispatched simultaneously (true parallel, same `parallel_group`).

**Per-claim worker instructions** (substitute `<claim.id>` and `<claim.text>`):

> Verify the following claim:
> - id: `<claim.id>`
> - text: `<claim.text>`
>
> Determine:
> - `verified` (boolean) — always `true` (this worker ran).
> - `verdict` (string enum) — `"true"` (confirmed), `"false"` (contradicted), or `"unverifiable"` (no local evidence).
> - `evidence` (string) — one-sentence summary of what was found and where. For `"unverifiable"`, state what was searched.
>
> Write the JSON handoff to `.spindle/features/fact-check/.handoffs/verify-<claim.id>.json`.
> Schema id: `claim`. Wrap the single result in a `claims` array:
> `{"claims":[{"id":"<claim.id>","text":"<claim.text>","verified":true,"verdict":"<verdict>","evidence":"<evidence>"}]}`

After **all** verify-workers return, complete each one:

```bash
# repeat for every claim id
spin complete verify-<claim.id> --handoff .spindle/features/fact-check/.handoffs/verify-<claim.id>.json
```

- Exit 1 on any → `spin retry verify-<claim.id> --inc`, re-dispatch that single `factcheck-verify-worker`. Stop at ceiling.
- Once all claims are marked complete, proceed to Stage 3.

---

## Stage 3 — Correct flagged claims in parallel (sonnet)

Read all verify handoffs. Collect claims where `verdict == "false"` or `verdict == "unverifiable"` from the `claims[0]` entry in each handoff file.

If no claims are flagged, skip to **Done**.

```bash
spin route claim-verify   # correction pass uses the same tier as verification
# -> { tier: "sonnet", model: "..." }
```

Fan out **all flagged claims in a single message** — one `factcheck-verify-worker` Task per flagged claim, each instructed to produce a corrected claim.

**Per-claim correction worker instructions** (substitute `<claim.id>`, `<claim.text>`, `<claim.verdict>`, `<claim.evidence>`):

> The following claim was flagged during verification:
> - id: `<claim.id>`
> - original text: `<claim.text>`
> - verdict: `<claim.verdict>`
> - verification evidence: `<claim.evidence>`
>
> Write a corrected version of the claim text. Set `verdict` to `"true"` only if the correction is supported by local evidence; otherwise `"unverifiable"`. Record what changed and why in the `evidence` field.
>
> Write the JSON handoff to `.spindle/features/fact-check/.handoffs/correct-<claim.id>.json`.
> Schema id: `claim`. Wrap in a `claims` array:
> `{"claims":[{"id":"<claim.id>","text":"<corrected text>","verified":true,"verdict":"<verdict>","evidence":"<correction note>"}]}`

After all correction workers return, complete each one:

```bash
spin complete correct-<claim.id> --handoff .spindle/features/fact-check/.handoffs/correct-<claim.id>.json
```

- Exit 1 → `spin retry correct-<claim.id> --inc`, re-dispatch. Stop at ceiling.

---

## Done

Surface the pipeline summary to the user:

- Total claims extracted
- Verified: N `"true"` / N `"false"` / N `"unverifiable"`
- Corrections produced: list each `claim.id` with the corrected text and `evidence` note
- Any handoffs that hit the retry ceiling (manual review required)

Do not merge corrections back into the source file unless the user explicitly requests it.
