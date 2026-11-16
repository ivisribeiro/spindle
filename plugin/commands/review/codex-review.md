---
name: codex-review
description: Native cross-vendor review — Spindle runs the codex (OpenAI) CLI directly as an independent reviewer of the current work, adapts its output into a `finding` sidecar (source=codex), and lets the deterministic G_REVIEW_BLOCK gate decide. The strongest form of "the verifier is not the generator": a different vendor judges the code Claude wrote. Opt-in. If the independent review cannot run or its output is unusable, report it as unavailable and fall back to /review.
---

Run an independent cross-vendor review of the current diff (or a target path) using the
codex (OpenAI) CLI, and feed the result into Spindle's own review gate. Claude wrote the
code; a different vendor judges it. The spin spine never calls a model — the codex
invocation lives in `scripts/codex-review.sh` (the model side); the gate that decides is
pure code.

**Setup, auth, and config:** see `docs/codex-review.md` — install the codex CLI, authenticate
(`codex login` or `OPENAI_API_KEY`), and the optional `.spindle/codex.env` knobs
(`SPINDLE_CODEX_ENABLED` / `_MODEL` / `_FLAGS`). Spindle stores no credential.

## When to run

This is an EXTRA, additive step — it changes nothing in the normal flow. Run it ONLY when
warranted: high-stakes or hard-to-reverse work (the T2 path from `spin tier`) — a
security-sensitive change, a migration, an architectural decision, or a final pre-ship
check on a critical feature. Routine, low-risk changes do not need a cross-vendor pass; the
Claude-side `/review` gate already covers them. Reach for `/codex-review` when a second
vendor's independent judgment is worth the cost, and skip it otherwise.

## Steps

### 1. Run the native cross-vendor reviewer

```bash
mkdir -p .spindle/review/.handoffs &&
  bash "${CLAUDE_PLUGIN_ROOT}/scripts/codex-review.sh" "diff" > .spindle/review/codex-raw.txt
```

For a scoped review, pass a validated project-relative path as one argument.
Check the shell exit code before using the newly captured response. Read
`.spindle/review/codex-raw.txt` only after the command succeeds.

- `CODEX_DISABLED`, `CODEX_UNAVAILABLE`, or `CODEX_ERROR`: report the independent
  review as unavailable for this run. Fall back to `/review` and stop this flow
  before writing a Codex handoff or running its gate.
- Otherwise parse the response as JSON. Require an array. An empty array is
  a valid response. An empty file, prose, or invalid JSON is an unavailable
  review. Follow the same fallback without reusing any earlier sidecar.

### 2. Adapt codex output into a `finding` sidecar

Normalize each entry to the `finding` contract and FORCE
`source` to `"codex"`:

```json
{ "findings": [
  { "severity": "critical|high|medium|low", "file": "<path>", "line": <N or null>,
    "rule": "<short>", "message": "<evidence>", "source": "codex" }
] }
```

Preserve the severity and evidence in every finding. If a record cannot meet the
contract, report an unusable review and use the fallback. Write the result to:

```
.spindle/review/.handoffs/codex.json
```

If codex returned an empty array, write `{ "findings": [] }`.

### 3. Validate the handoff

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/codex.json
```

Proceed to the gate only on exit 0. If validation fails, report the error and
use the fallback. Do not invent findings or replace invalid output with an empty array.

### 4. Gate — Spindle decides, not codex

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_REVIEW_BLOCK --findings .spindle/review/.handoffs/codex.json
```

Spindle's own deterministic gate is the judge of record — never codex's own stop behavior.

- Exit 1 → STOP. A cross-vendor CRITICAL finding survived. Surface `reasons` and `unmet`
  verbatim, list the critical findings (file, line, rule, message), and do not proceed.
- Exit 0 → no surviving CRITICAL from codex. Continue.
- Exit 2 or 3 → stop and report the CLI error.

### 5. (Optional) merge with the Claude-side critics

For the strongest independence, run this alongside `/review` and merge both finding sets
deterministically, then require two attributed sources. Use explicit sidecar
paths from the current review only. In the example, replace the Claude sidecar
path with the current validated findings file:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js merge-findings .spindle/review/.handoffs/codex.json .spindle/review/filtered-findings.json --out findings.json
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_REVIEW_BLOCK --findings findings.json --min-sources 2
```

`merge-findings` dedups and aggregates the `sources` summary; `--min-sources 2` makes
`G_REVIEW_BLOCK` require >=2 distinct sources (e.g. `codex` + `arch-worker`). Counts reflect source labels present in the findings. An empty review adds no
source label. Confirm which reviewers actually ran from their current outputs.

### 6. Report

Summarize for the user: codex findings by severity, which critical findings the gate
blocked on, and the path to `.spindle/review/.handoffs/codex.json`. Make clear this is one
independent reviewer raising the bar — it is not a proof of correctness.
