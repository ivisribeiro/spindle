---
name: review
description: Parallel adversarial code review — fan out arch-worker + security-worker (sonnet), merge findings deterministically via `spin merge-findings`, challenge every surviving critical finding with the challenger adversary (opus), drop refuted, write survivors to findings.json, gate G_REVIEW_BLOCK.
---

Run an adversarial parallel code review against the current diff or target path.

## Where outputs live

This command writes to `.spindle/review/` (raw worker findings, handoff sidecars,
merged/filtered intermediates) and to `findings.json` at the project root. These
are **transient command outputs**, not run-ledger state — nothing under
`.spindle/review/` is read by `spin next`, `spin state`, or any phase gate.
Only the explicit `--findings <file>` path you pass to `spin gate
G_REVIEW_BLOCK` in step 11 matters to the CLI. Keep or delete `.spindle/review/`
between runs as you like; it is scratch space for this review, nothing more.

## Steps

### 1. Determine run mode (standalone vs in-run)

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js state
```

- **Exit 0** → an active Spindle run exists (`.spindle/run.json` present). Use
  `spin retry <id> --inc` / `--ok` for every bounded re-dispatch below — the
  ledger tracks the counter against `config.build_retry_cap`.
- **Exit 2** (`"no run state — run \"spin init\" first"`) → this is a standalone
  review with no active run. `spin retry` itself requires a run and will exit 2
  here — do NOT call it. Instead track re-dispatch attempts yourself, scoped to
  this command invocation, with a hard documented cap of **2 re-dispatches per
  artifact** (`arch`, `security`, and each individual adversary dispatch from
  step 7). On the 3rd consecutive invalid handoff for the same artifact, STOP
  and report to the user — this mirrors hitting the ledger's retry ceiling,
  just counted in-command since there is no ledger to count it in.

Remember which mode applies. Every "STOP on exit 1" retry block below branches
on it — never let a missing run crash the command mid-review.

### 2. Route both analysis workers

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route finding-analysis
```

The route command returns the tier for `finding-analysis` (sonnet). Both arch-worker and security-worker run at this tier.

### 3. Fan out arch-worker + security-worker in parallel

Dispatch BOTH workers in a SINGLE Task message (true parallel, same parallel_group). Pass each worker:

- The target (diff, file, or directory path) to review
- Its role and the required handoff schema

**arch-worker instructions:**

> You are the architecture reviewer. Analyze the target for structural bugs, data-flow issues, coupling violations, incorrect abstractions, and logic errors.
>
> For each finding produce one JSON object:
> ```json
> { "severity": "critical|high|medium|low", "file": "<path>", "line": <N or null>, "rule": "<short rule/category>", "message": "<evidence-grounded explanation>", "source": "<arch-worker|security-worker>" }
> ```
>
> Write a JSON array of all findings to:
> `.spindle/review/arch-findings.json`
>
> Then write a handoff sidecar to:
> `.spindle/review/.handoffs/arch.json`
> matching the `finding` handoff schema:
> `{ "findings": [ ...same array... ] }`

**security-worker instructions:**

> You are the security reviewer. Analyze the target for injection flaws, authentication/authorization bypasses, secret leakage, insecure deserialization, unsafe dependencies, and OWASP Top-10 patterns.
>
> For each finding produce one JSON object:
> ```json
> { "severity": "critical|high|medium|low", "file": "<path>", "line": <N or null>, "rule": "<short rule/category>", "message": "<evidence-grounded explanation>", "source": "<arch-worker|security-worker>" }
> ```
>
> Write a JSON array of all findings to:
> `.spindle/review/security-findings.json`
>
> Then write a handoff sidecar to:
> `.spindle/review/.handoffs/security.json`
> matching the `finding` handoff schema:
> `{ "findings": [ ...same array... ] }`

### 4. Validate arch-worker handoff

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/arch.json
```

Exit 1 → handoff is invalid.

- **In-run mode:**
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry arch --inc
  node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry arch --ok
  ```
  `--ok` exit 0 → re-dispatch arch-worker (step 3, arch only). `--ok` exit 1 → ceiling reached, STOP and report to the user.
- **Standalone mode:** increment your own in-command counter for `arch`. Below the cap of 2 → re-dispatch arch-worker (step 3, arch only). At the cap → STOP and report to the user.

Exit 0 → continue.

### 5. Validate security-worker handoff

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/security.json
```

Exit 1 → handoff is invalid.

- **In-run mode:**
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry security --inc
  node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry security --ok
  ```
  `--ok` exit 0 → re-dispatch security-worker (step 3, security only). `--ok` exit 1 → ceiling reached, STOP and report to the user.
- **Standalone mode:** increment your own in-command counter for `security`. Below the cap of 2 → re-dispatch security-worker (step 3, security only). At the cap → STOP and report to the user.

Exit 0 → continue.

### 6. Merge findings deterministically

Do not hand-merge or dedup in prose — call the primitive built for exactly this:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js merge-findings .spindle/review/arch-findings.json .spindle/review/security-findings.json --out .spindle/review/merged-findings.json
```

`merge-findings` dedups by `(file, line, rule)`, keeps the higher severity on a
collision (critical > high > medium > low), and aggregates `sources`. Read
`.spindle/review/merged-findings.json` for every step below — it is now the
single source of truth for pre-adversary findings.

### 7. Route the adversary for surviving critical findings

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route adversary
```

The route command returns opus for `adversary` (critical kind, never
downgraded — see the routing doctrine). Use the returned model for every
challenger dispatch in step 8. This is the same task-kind and the same worker
(`plugin/agents/_adversary/challenger.md`) that `/migrate` and `/design`
(strict) dispatch — `/review` does not invent a separate adversary contract.

### 8. Dispatch the challenger adversary for each critical finding — in parallel

From `.spindle/review/merged-findings.json`, collect all findings where
`severity == "critical"`. If there are none, copy
`.spindle/review/merged-findings.json` to `findings.json` and skip to step 11.

Otherwise dispatch the **challenger** worker agent
(`plugin/agents/_adversary/challenger.md`) via the Task tool, **once per
critical finding**, in a SINGLE Task message (true parallel) — the same
adversary agent `/migrate` and `/design` (strict) dispatch. Per the
challenger's anti-anchoring rule, give each dispatch ONLY the artifact under
test — never the arch-worker's or security-worker's confidence, reasoning, or
self-assessment:

- The finding itself: `{file, line, severity, rule, message}` — nothing more.
- The file paths needed to verify it against ground truth (the flagged file,
  and any file the finding's `message` references).
- Instructions:

  > Assume this location has no real critical problem — treat the reported
  > finding as an unproven claim you must independently confirm or refute.
  > Hunt for the concrete evidence (the reachable path, the unmitigated code,
  > the exploitable input) that proves the issue is genuine. If you cannot
  > find independent confirming evidence despite a real attempt, the
  > challenge is upheld: emit `{"findings": []}`. If you DO find independent
  > confirming evidence, emit it as your own `findings[]` entries per the
  > `finding` handoff schema (`severity: "critical"`, `source: "challenger"`,
  > one entry per concrete counter-example — see
  > `plugin/agents/_adversary/challenger.md` for the exact contract).
  >
  > Write your `finding` handoff sidecar to:
  > `.spindle/review/.handoffs/adversary-<slug>.json`
  > where `<slug>` is a short sanitized form of `<file>:<line>:<rule>`.

### 9. Validate each adversary handoff

For every `.spindle/review/.handoffs/adversary-<slug>.json` produced in step 8:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/adversary-<slug>.json
```

Exit 1 → the handoff does not match the `finding` schema.

- **In-run mode:** `spin retry adversary-<slug> --inc` / `--ok`, same pattern as step 4.
- **Standalone mode:** in-command counter for `adversary-<slug>`, cap 2, same pattern as step 4.

Re-dispatch only that challenger (step 8, that finding only). Exit 0 on all → continue.

### 10. Drop refuted critical findings, then assemble the final findings file

For each critical finding in `.spindle/review/merged-findings.json`, read its
corresponding `.spindle/review/.handoffs/adversary-<slug>.json`:

- `findings: []` (empty) → the challenge is upheld: the finding is refuted. Drop it.
- `findings: [...]` (non-empty) → independently confirmed. Keep the original finding.

This is a mechanical keep/drop filter by one boolean per finding — it does not
re-derive severity or re-run the merge algorithm; `merge-findings` already did
that substantive work in step 6. Write the filtered array (all non-critical
findings unchanged, plus only the surviving criticals) to
`.spindle/review/filtered-findings.json`.

Then combine the filtered findings with every challenger's own confirming
evidence via the same primitive used in step 6:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js merge-findings .spindle/review/filtered-findings.json .spindle/review/.handoffs/adversary-*.json --out findings.json
```

Confirmations from refuted findings contribute empty arrays and add nothing;
confirmations from surviving findings add the challenger's own independent
evidence, deduped against the original by `(file, line, rule)` and aggregated
into `sources`. `findings.json` (project root) is the sole input to the gate.

### 11. Gate G_REVIEW_BLOCK

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_REVIEW_BLOCK --findings findings.json
```

Exit 1 → STOP. At least one critical finding survived adversarial review. Surface `reasons` and `unmet` to the user. List the surviving critical findings with their file, line, title, and detail. Do not proceed.

Exit 0 → continue.

### 12. Report

Surface the review summary to the user:

- Total findings from arch-worker + security-worker (before dedup)
- Findings after `merge-findings` dedup (step 6)
- Critical findings challenged by the challenger adversary (step 8)
- Critical findings refuted (dropped in step 10)
- Critical findings surviving (should be 0 if the gate passed)
- Non-critical findings (high / medium / low) — listed for the user's attention but do not block
- Which run mode applied (in-run `spin retry` vs standalone in-command counter), if any re-dispatches occurred
- Path to `findings.json` for the full annotated record
