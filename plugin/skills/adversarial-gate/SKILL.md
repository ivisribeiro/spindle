---
name: adversarial-gate
description: Adversarial verification pattern — dispatch N independent critics (the challenger worker, routed via `spin route adversary`) that try to REFUTE an artifact, aggregate their typed `finding` sidecars into one file, then let `spin gate G_REVIEW_BLOCK` decide: any surviving CRITICAL finding blocks. Use when a CRITICAL artifact must survive challenge before it advances, not merely pass a self-review.
---

# Adversarial gate

## What backs this skill

The mechanism is two concrete pieces of code working together:

**`gReviewBlock` in `src/core/gates/review-gate.ts`** — the gate function registered as `G_REVIEW_BLOCK`. It receives a single `--findings <file>` argument, reads and parses the JSON, validates the full document against the `finding` handoff schema (via `checkHandoffObject`), counts entries where `severity === "critical"`, and returns a typed `GateResult`. The shape guard is strict by design: a missing or wrong-typed `findings` key does NOT silently resolve to zero findings — it exits 1 with `findings-shape` in `unmet`. There is no separate `verdict` field the gate reads. A refutation that is not encoded as a `critical` entry in `findings[]` does not block.

**`plugin/agents/_adversary/challenger.md`** — the critic worker. It is read-only (`Read`, `Grep`, `Glob`, `Bash` for inspection only; no writes, no model-dispatch calls). It restates each claim as a falsifiable proposition, hunts for concrete counter-examples, and emits the `finding` handoff sidecar. It carries one hard rule: on a safety-critical surface (data loss, PII/secret exposure, irreversible migration, auth boundary, financial correctness), uncertainty is a refutation — emit `critical`, do not give the benefit of the doubt.

The exit-code ABI (`0` = pass, `1` = block, `2` = usage error, `3` = internal error) and the retry/complete loop are owned by `harness-protocol`. Read that skill for the full gate protocol; this skill does not restate it.

---

A single reviewer rubber-stamps. This pattern instead runs independent critics whose job is to break the artifact, then lets the gate decide. The CLI is the judge of record; the critics only produce typed evidence.

## Five rules (do not relax)

1. **Independence (anti-anchoring).** Each critic is a separate Task dispatch that sees ONLY the artifact under test — never the generator's rationale, never another critic's findings, never a prior round's verdict. Shared context creates correlated blind spots. One missed CRITICAL is a broken gate.
2. **Try-to-refute framing.** The challenger's standing instruction is "find the CRITICAL flaw that makes this wrong," not "review this." Reward refutation, not agreement.
3. **Typed verdict.** Every critic emits typed `finding` items — `{ file, severity, rule, message, source }`, `severity ∈ critical|high|medium|low`. No prose-only verdicts. `gReviewBlock` reads the typed findings, not your summary.
4. **Gate owns the verdict.** You do NOT decide pass/block. Aggregate all critics' items into ONE `finding` file, run `spin gate G_REVIEW_BLOCK --findings <file>`, and branch strictly on exit code. The gate's `critical`-count is the verdict.
5. **Hard round cap.** Refute → fix → re-challenge is bounded by `spin retry <id> --inc` / `--ok` against `config.build_retry_cap`. No infinite adversarial loops.

## Procedure

### 1. Confirm the target is ready and route the critic tier

```bash
spin next                 # the artifact under challenge must appear in ready[]
spin route adversary      # -> OPUS tier. adversary NEVER downgrades under --budget low.
```

The critic outranks-or-equals the generator on a CRITICAL gate. Routing below OPUS here is an anti-pattern (`gReviewBlock`'s own comment documents why: "a cheaper tier is never the final judge of a CRITICAL finding").

### 2. Fan out N independent critics in ONE message (true parallel)

Dispatch critics as parallel Task calls in a **single** message so they run concurrently and cannot see each other. Give each the SAME artifact and the SAME try-to-refute brief; give them NOTHING else. An odd N (3 is the default) widens coverage — any one critic landing a CRITICAL is enough to block; `gReviewBlock` does not need a quorum.

Each critic MUST:
- attempt to refute the artifact, focusing on CRITICAL defects;
- write its result as a `finding` JSON sidecar shaped `{ "findings": [ … ] }` where each entry is `{ file, severity, rule, message, source }` (`line` optional, `severity ∈ critical|high|medium|low`);
- emit `{ "findings": [] }` — an explicit empty array — when it genuinely tried and found nothing.

The `source` field identifies the individual critic (`"challenger-1"`, `"challenger-2"`, etc.). Note what this provides and what it does not: distinct `source` strings in one aggregated findings file prove attribution of each finding, NOT process isolation. True critic independence lives in the orchestration layer — separate Task dispatches that never share context. Attribution and independence are different guarantees; the orchestration supplies the second one, not the JSON field.

### 3. Validate each critic's handoff before aggregating

Before merging, prove each sidecar is a structurally valid `finding` — never trust prose:

```bash
spin handoff-check finding .spindle/features/<feature>/.handoffs/<criticId>.json
```

Exit `1` means that sidecar is malformed: re-dispatch that ONE critic, bounded by the retry counter. A critic that cannot produce a typed verdict does not get to vote.

### 4. Aggregate into ONE findings file, then run the gate

`gReviewBlock` reads a SINGLE JSON file shaped `{ "findings": [ … ] }`, not a directory of per-critic sidecars. The gate's shape guard is strict — passing a directory path or a file without a `findings` array exits 1 with `findings-shape` in `unmet`, NOT zero findings. Aggregate first:

```bash
# Merge all critics' findings[] arrays into one finding handoff.
jq -s '{ findings: map(.findings) | add }' \
  .spindle/features/<feature>/.handoffs/critic-*.json \
  > .spindle/features/<feature>/.handoffs/findings.json

spin gate G_REVIEW_BLOCK --findings .spindle/features/<feature>/.handoffs/findings.json
```

Branch strictly on the exit code (see `harness-protocol` for the full ABI table):

- **exit 0** — no surviving CRITICAL findings. `gReviewBlock` returned `pass(gate, ["no surviving CRITICAL findings over N total"])`. The artifact passed the challenge. Proceed.
- **exit 1** — BLOCK. Surface `reasons` and `unmet` verbatim (each `reasons` entry is `"CRITICAL: <rule> @ <file> — <message>"` from `gReviewBlock`). Go to the bounded refute loop.

### 5. Bounded refute → fix → re-challenge loop

Each time the gate blocks and the generator fixes the artifact, count the round and re-challenge with a fresh, independent panel (step 2). The cap bounds the loop:

```bash
spin retry <id> --inc     # one charge per re-challenge round
spin retry <id> --ok      # exit 1 == ceiling hit (config.build_retry_cap) -> STOP
```

When `--ok` exits `1`: STOP. Do not advance. Report the surviving CRITICAL `reasons`/`unmet` and the exhausted round count, and hand the decision back to the human. A blocked-at-ceiling artifact never silently proceeds.

## The omission checklist (hunt what is MISSING, not just defects in what is there)

A critic that only refutes what is written misses the most expensive class of flaw: the task or test that should exist and does not. The challenger's strongest real contribution on a live plan was five omitted tasks — found only by asking "what breaks under repetition / concurrency / redeploy?". So every critic, in addition to refuting the artifact, MUST answer this fixed checklist for each claim marked "done", "resolved", or "safe":

- **Regression** — is there a test that PINS this fix? A bug fixed without a test reopens on the next refactor.
- **Idempotency** — does it stay correct across N repeated runs? Schedulers, retries, replays. A "full reload" that appends instead of replacing silently corrupts data across cron runs.
- **Concurrency** — is it safe under concurrent execution? A path that was "flaky once" is a concurrency bug a single retry hid.
- **Redeploy / restart** — does it survive a process restart or container recreate? Connection leaks, in-memory state, orphaned resources.
- **Inert-by-config** — is the capability actually ENFORCED in prod, or merely coded? A flag whose code default is unsafe and whose prod override was never verified is a live hole no static review catches.

Unanswered items become `finding` entries. Track the invariants explicitly — isolation, idempotency, concurrency-safety — so "acknowledged in a comment but no test asserts it" becomes a typed, plannable item rather than buried prose.

## Cross-vendor critic (native, optional)

The critics above are Claude subagents. Spindle ships one critic from a different vendor:
the `/codex-review` command runs the codex (OpenAI) CLI directly (via
`scripts/codex-review.sh`), adapts its output into a `finding` sidecar with `source: codex`,
and feeds it to the SAME `G_REVIEW_BLOCK`. A different vendor judging the code Claude wrote
is the strongest form of "the verifier is not the generator" — it catches the correlated
blind spots a single model has about its own work.

It is **opt-in and fail-open**: if the codex CLI is not installed, `/codex-review` reports a
skip and you fall back to the Claude-side panel above — never a block. And the verdict is
still Spindle's: the codex output becomes typed findings, and the deterministic
`G_REVIEW_BLOCK` decides — never codex's own stop behavior. The codex invocation lives in
the script (the model side); the spin spine never calls it.

## Anti-patterns

- **Shared-context critics** — reusing one chat thread or piping critic A's output into critic B destroys independence (rule 1). Always separate Task dispatches seeing only the artifact.
- **You decide the verdict** — eyeballing the findings and declaring the artifact "fine." The gate decides; aggregate the findings, run `spin gate G_REVIEW_BLOCK`, branch on the exit code.
- **Directory as `--findings`** — pointing the gate at the `.handoffs/` folder instead of one aggregated `findings.json`. `gReviewBlock` calls `JSON.parse` on a single file; a directory path throws and the gate blocks with `findings-file` in `unmet`. Aggregate first (step 4).
- **Cheaper final judge** — routing the critic below OPUS to save budget. The adversary kind never downgrades. The gate comment makes this explicit: "a cheaper tier is never the final judge of a CRITICAL finding."
- **Unbounded re-challenge** — looping fix → re-challenge without `spin retry --inc` / `--ok`. The round cap is mandatory; omitting it is an infinite loop bug.
- **Prose verdicts** — accepting a critic's "looks good" without a typed `finding` sidecar that passes `spin handoff-check finding`. No valid sidecar, no vote. A refutation not encoded as a `critical` entry in `findings[]` does not reach `gReviewBlock` and does not block.
- **Missing `findings` key** — submitting `{}` or a flat finding object as the aggregated file. `gReviewBlock`'s shape guard treats this as a hard block (`findings-shape`), not as zero findings. Always emit `{ "findings": [] }` explicitly when clean.
