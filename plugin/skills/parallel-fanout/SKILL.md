---
name: parallel-fanout
description: |
  Explains and enforces the spin parallel fan-out pattern: when to parallelize vs sequence work,
  how to dispatch multiple workers in a single Task message, how typed handoffs wire independent
  artifacts into a gate, and how failure isolation works per-artifact.
  Use PROACTIVELY when the user asks how to run multiple agents at once, how parallel_group
  works, how to fan out tasks, or why a gate blocked after parallel workers.
---

# Parallel Fan-Out in the spin Harness

The harness has one invariant: `spin` makes every ordering and gate decision; Claude only
authors artifacts and fans out workers. Parallel execution is a direct consequence of
`spin next` returning more than one artifact in the same `parallel_group`.

---

## Lane Matrix

| Lane | When to use | `spin` behavior |
|------|-------------|----------------|
| **Parallel** | Artifacts are independent — no dependency edge between them | `spin next` returns all of them in the same `parallel_group`; dispatch all in a SINGLE message |
| **Sequential** | Artifact B reads the output of artifact A | `spin next` returns A alone; B appears only after `spin complete A` succeeds |
| **Retry loop** | A worker's handoff fails `spin complete --handoff` validation | `spin retry <id> --inc` increments the counter; `--ok` exits 1 at the `build_retry_cap` ceiling — stops the loop |
| **Gate-blocked** | A gate returns exit 1 | STOP, surface `{reasons, unmet}` to the user; do not advance or bypass |

Mixing lanes is fine inside one workflow step: some artifacts in the ready set may be
independent (fan them out) while others in a later step depend on those outputs (sequence them).

---

## When to Parallelize vs Sequence

**Parallelize** when all of these are true:
- Artifacts do not read each other's output files.
- They belong to the same workflow phase (e.g., all DEFINE artifacts, or all BUILD artifacts
  in the same level of the topological order).
- `spin next` places them in the same `parallel_group`.

**Sequence** when any of these is true:
- A dependency edge exists (B's prompt or handoff schema references A's artifact path).
- A gate must pass before the next phase can start (gates are always sequential checkpoints).
- `spin next` returns only one artifact (`parallel_group` is absent or unique).

Never infer dependency from topic similarity alone — trust `spin next` exclusively.

---

## Single-Message Task Fan-Out

`spin next` returns a ready list. When two or more items share the same `parallel_group`,
dispatch ALL of them in one message using multiple simultaneous Task calls.

**Protocol (5 steps, executed for every fan-out):**

```bash
# Step 1 — ask the harness what is ready
spin next
# -> { ready: [{id:"DEFINE", model:"sonnet", parallel_group:"phase-define"},
#              {id:"BRAINSTORM", model:"opus", parallel_group:"phase-define"}],
#      blocked: {}, complete: false }
```

```
# Step 2 — route each artifact (same message, before dispatching)
spin route define-intent          # -> { tier: "opus", model: "...", reason: "..." }
spin route spec-authoring         # -> { tier: "sonnet", model: "...", reason: "..." }
```

```
# Step 3 — fan out: dispatch BOTH workers in ONE message via Task
#   Worker A writes .spindle/features/<feature>/DEFINE.md + .spindle/features/<feature>/.handoffs/define.json
#   Worker B writes .spindle/features/<feature>/BRAINSTORM.md + .spindle/features/<feature>/.handoffs/brainstorm.json
```

```bash
# Step 4 — validate and complete EACH artifact after its worker finishes
spin complete DEFINE --handoff .spindle/features/<feature>/.handoffs/define.json
# exit 0 -> marked complete
# exit 1 -> handoff invalid: call spin retry DEFINE --inc (re-dispatch bounded by --ok ceiling)

spin complete BRAINSTORM --handoff .spindle/features/<feature>/.handoffs/brainstorm.json
```

```bash
# Step 5 — run the phase gate once ALL artifacts in the group are complete
spin gate G_DEFINE
# exit 0 -> advance to /design
# exit 1 -> { gate:"G_DEFINE", passed:false, reasons:[...], unmet:[...] } -> STOP
```

Never call `spin complete` without `--handoff` when a handoff schema applies.
Never call `spin gate` before every artifact in the group is complete.

---

## Typed Handoffs

Every worker writes a JSON sidecar that matches one of the harness handoff schema ids.
`spin complete <id> --handoff <file>` validates the sidecar against the schema before
marking the artifact complete (exit 1 if invalid).

| Handoff schema id | Typical producer artifact |
|-------------------|--------------------------|
| `define` | DEFINE.md (acceptance criteria, problem statement) |
| `design` | DESIGN.md (manifest table, architecture decisions) |
| `build-task` | Any BUILD artifact (one per file in the manifest) |
| `build-report` | BUILD_REPORT.md (aggregate of all build-task results) |
| `finding` | Any /review or /migrate finding block |
| `claim` | A verifiable claim from /review |
| `migration-plan` | MIGRATION_PLAN.md |
| `claudemd-section` | A CLAUDE.md section edit |
| `kb-concept` | A KB concept file |

Validate a sidecar without marking complete:

```bash
spin handoff-check define .spindle/features/my-feature/.handoffs/define.json
# exit 0 = schema valid; exit 1 = schema invalid with reasons
```

---

## Failure Isolation

Each artifact is an independent unit. A worker failure or invalid handoff does NOT
block sibling artifacts in the same `parallel_group`.

**Isolation rules:**
1. Run `spin complete` independently for each artifact. A failure on one does not abort others.
2. `spin retry <id> --inc` increments the retry counter for that artifact only.
3. `spin retry <id> --ok` exits 1 (stop re-dispatch) when the counter reaches `build_retry_cap` — surface the failure to the user.
4. Run `spin gate <gateId>` only after ALL artifacts in the group have reached a terminal state
   (complete or failed-at-ceiling). The gate aggregates all outcomes and returns a single
   exit code for the phase.
5. A gate exit 1 blocks the entire workflow — no artifact from a later phase may be dispatched
   until the gate clears.

```bash
# Bounded retry loop for one artifact
spin retry BUILD_FOO --inc   # exit 0 -> re-dispatch worker
spin retry BUILD_FOO --inc   # exit 0 -> re-dispatch worker
spin retry BUILD_FOO --ok    # exit 1 at ceiling -> surface to user, do not re-dispatch
```

---

## Model-Routing Doctrine for Parallel Workers

Run `spin route <kind>` for EACH artifact before dispatching. Independent artifacts in
the same fan-out may land on different model tiers — that is expected and correct.

- Cheapest tier that a gate backstops: `file-read`, `template-fill`, `frontmatter-parse` → **HAIKU**
- Authoring and analysis: `spec-authoring`, `design-synthesis`, `code-build`, `kb-concept` → **SONNET**
- Adversarial / deepest reasoning: `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge` → **OPUS**

Hard rules (never bypass):
- Under `--budget low`, downgrade ONLY where a deterministic gate backstops the output.
- The verifier/adversary must be at or above the generator's tier on any CRITICAL gate.
- Critical kinds (`adversary`, `architect`, `review-judge`, `*-intent`) never downgrade.

---

## Quick Reference: Gate Sequence

```
/define  ->  spin gate G_DEFINE  (DEFINE sections + AC-n ids + define handoff valid)
/design  ->  spin gate G_DESIGN  (manifest table + design handoff)
/build   ->  spin gate G_BUILD   (every manifest file on disk + criteria-diff empty + BUILD_REPORT)
/ship    ->  spin gate G_SHIP    (define.criteria minus build.passed must be empty)
/review  ->  spin gate G_REVIEW_BLOCK  (surviving CRITICAL findings > 0 -> block)
```

Check unmet criteria between phases:

```bash
spin diff-criteria --define .spindle/features/my-feature/DEFINE.md \
                  --build  .spindle/features/my-feature/BUILD_REPORT.md
# exits 0 if unmet[] is empty; exits 1 with unmet list if criteria are missing
```

---

## Anti-Patterns

| Anti-pattern | Why it breaks | Correct approach |
|---|---|---|
| Dispatching workers sequentially when `parallel_group` is shared | Wastes wall time; hides the real concurrency model | Fan out all ready artifacts in ONE message |
| Calling `spin complete <id>` without `--handoff` | Skips schema validation; G_HANDOFF gate will block | Always pass `--handoff <sidecar>` when a handoff schema applies |
| Advancing to the next phase before calling `spin gate` | Skips the deterministic gate; may ship invalid artifacts | Call the gate after every phase; branch strictly on exit code |
| Retrying indefinitely without `spin retry --ok` | Infinite loop on permanent failures | Use `--inc` / `--ok` to respect `build_retry_cap` |
| Inferring dependency from topic similarity | Wrong sequencing | Trust `spin next` and `parallel_group` exclusively |
| Dispatching workers from outside a command (e.g., from a node script) | Fake-dispatch anti-pattern — model runs outside the command layer | Workers are always dispatched via the Task tool inside slash commands |
