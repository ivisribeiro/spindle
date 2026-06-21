---
name: review
description: Parallel adversarial code review — fan out arch-worker + security-worker (sonnet), dedup findings by file+line, challenge every critical finding with a review-judge (opus), drop refuted, write survivors to findings.json, gate G_REVIEW_BLOCK.
---

Run an adversarial parallel code review against the current diff or target path.

## Steps

### 1. Route both analysis workers

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route finding-analysis
```

The route command returns the tier for `finding-analysis` (sonnet). Both arch-worker and security-worker run at this tier.

### 2. Fan out arch-worker + security-worker in parallel

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

### 3. Validate arch-worker handoff

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/arch.json
```

Exit 1 → handoff is invalid. Run:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry arch --inc
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry arch --ok
```

If `--ok` exits 0 → re-dispatch arch-worker (step 2, arch only). If `--ok` exits 1 → ceiling reached, STOP and report to the user.

### 4. Validate security-worker handoff

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check finding .spindle/review/.handoffs/security.json
```

Exit 1 → handoff is invalid. Run:

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry security --inc
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry security --ok
```

If `--ok` exits 0 → re-dispatch security-worker (step 2, security only). If `--ok` exits 1 → ceiling reached, STOP and report to the user.

### 5. Dedup and merge findings

Read `.spindle/review/arch-findings.json` and `.spindle/review/security-findings.json`. Merge into a single list, deduplicating by `(file, line)` — when two findings share the same file+line keep the one with the higher severity (critical > high > medium > low); if equal severity, keep the more detailed `detail`. Write the merged list to `.spindle/review/merged-findings.json`.

### 6. Route the adversary for critical findings

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route review-judge
```

The route command returns opus for `review-judge` (critical kind, never downgraded). Use the returned model for every adversary dispatch below.

### 7. Dispatch adversary (review-judge) for each critical finding — in parallel

From `.spindle/review/merged-findings.json`, collect all findings where `severity == "critical"`. If there are none, skip to step 8.

Dispatch one review-judge worker **per critical finding** in a SINGLE Task message (true parallel). Pass each worker:

- The full text of the finding (file, line, title, detail)
- The source code context around that file+line
- Instructions:

  > You are an adversarial reviewer. Your job is to REFUTE this finding if you can.
  >
  > Attempt to show that the finding is: a false positive, based on a misread of the code, already mitigated elsewhere, not exploitable in context, or otherwise not a genuine critical issue.
  >
  > Respond with a JSON object:
  > ```json
  > { "finding_key": "<file>:<line>:<title>", "refuted": true|false, "reason": "<concise explanation>" }
  > ```
  >
  > Set `refuted: true` ONLY if you have a concrete, evidence-grounded argument that the finding is not a real critical issue. Uncertainty or partial doubt is NOT sufficient — default to `refuted: false`.
  >
  > Write this JSON object to:
  > `.spindle/review/.handoffs/adversary-<slug>.json`
  > where `<slug>` is a short sanitized form of `finding_key`.

### 8. Apply adversary verdicts

Read every `.spindle/review/.handoffs/adversary-*.json` produced in step 7. For each finding in the merged list:

- If its adversary file has `"refuted": true` → mark the finding as `"status": "refuted"` and exclude it from survivors.
- All other findings (refuted: false, or no adversary dispatched because severity != critical) → mark as `"status": "survivor"`.

Write the final annotated list to `findings.json` (project root or the path `spin gate G_REVIEW_BLOCK` reads via `--findings`).

### 9. Gate G_REVIEW_BLOCK

```
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js gate G_REVIEW_BLOCK --findings findings.json
```

Exit 1 → STOP. At least one critical finding survived adversarial review. Surface `reasons` and `unmet` to the user. List the surviving critical findings with their file, line, title, and detail. Do not proceed.

Exit 0 → continue.

### 10. Report

Surface the review summary to the user:

- Total findings from arch-worker + security-worker (before dedup)
- Findings after dedup
- Critical findings challenged
- Critical findings refuted (dropped)
- Critical findings surviving (should be 0 if gate passed)
- Non-critical findings (high / medium / low) — listed for the user's attention but do not block
- Path to `findings.json` for the full annotated record
