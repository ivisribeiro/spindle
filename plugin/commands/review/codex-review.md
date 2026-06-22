---
name: codex-review
description: Native cross-vendor review — Spindle runs the codex (OpenAI) CLI directly as an independent reviewer of the current work, adapts its output into a `finding` sidecar (source=codex), and lets the deterministic G_REVIEW_BLOCK gate decide. The strongest form of "the verifier is not the generator": a different vendor judges the code Claude wrote. Opt-in and fail-open — if the codex CLI is absent the command reports and falls back to /review.
---

Run an independent cross-vendor review of the current diff (or a target path) using the
codex (OpenAI) CLI, and feed the result into Spindle's own review gate. Claude wrote the
code; a different vendor judges it. The spin spine never calls a model — the codex
invocation lives in `scripts/codex-review.sh` (the model side); the gate that decides is
pure code.

## Steps

### 1. Run the native cross-vendor reviewer

```
bash ${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.sh "diff" > .spindle/review/codex-raw.txt 2>&1
```

(Replace `"diff"` with a path/dir to scope the review.) Read `.spindle/review/codex-raw.txt`.

- If it begins with `CODEX_UNAVAILABLE` → the codex CLI is not installed. This is a fail-open
  skip, NOT a block: tell the user the native cross-vendor review was skipped (install the
  codex CLI + `codex login` to enable) and run `/review` instead for the Claude-side
  adversarial pass. Stop here.
- If it begins with `CODEX_ERROR` → codex ran but failed (often auth). Report it and fall
  back to `/review`. Stop here.
- Otherwise the file holds codex's review (expected: a JSON array of findings).

### 2. Adapt codex output into a `finding` sidecar

Extract the JSON array of findings from `.spindle/review/codex-raw.txt` (codex may wrap it
in prose — take only the array). Normalize each entry to the `finding` contract and FORCE
`source` to `"codex"`:

```json
{ "findings": [
  { "severity": "critical|high|medium|low", "file": "<path>", "line": <N or null>,
    "rule": "<short>", "message": "<evidence>", "source": "codex" }
] }
```

Map any non-conforming severity codex emits into the enum (e.g. `error`→`high`,
`warning`→`medium`, `info`→`low`). Write the result to:

```
.spindle/review/.handoffs/codex.json
```

If codex returned an empty array, write `{ "findings": [] }`.

### 3. Validate the handoff

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/codex.json
```

Exit 1 → the adaptation is malformed. Re-extract and rewrite the sidecar (you control this
step; the failure is in your JSON shaping, not the gate). Do not invent findings.

### 4. Gate — Spindle decides, not codex

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_REVIEW_BLOCK --findings .spindle/review/.handoffs/codex.json
```

Spindle's own deterministic gate is the judge of record — never codex's own stop behavior.

- Exit 1 → STOP. A cross-vendor CRITICAL finding survived. Surface `reasons` and `unmet`
  verbatim, list the critical findings (file, line, rule, message), and do not proceed.
- Exit 0 → no surviving CRITICAL from codex. Continue.

### 5. (Optional) merge with the Claude-side critics

For the strongest independence, run this alongside `/review` and merge both finding sets so
`G_REVIEW_BLOCK` sees critics from two vendors. The `source` field (`codex` vs
`arch-worker`/`security-worker`) keeps each finding attributable. Distinct sources prove
attribution; running them as separate passes (here, a separate vendor entirely) is what
gives genuine independence.

### 6. Report

Summarize for the user: codex findings by severity, which critical findings the gate
blocked on, and the path to `.spindle/review/.handoffs/codex.json`. Make clear this is one
independent reviewer raising the bar — it is not a proof of correctness.
