---
name: parallel-fanout
description: |
  Explains and enforces the spin parallel fan-out pattern: when to parallelize vs
  sequence work, how to dispatch multiple workers in a single Task message, how typed
  handoffs wire independent artifacts into a gate, and how failure isolation works
  per-artifact.
  Use PROACTIVELY when the user asks how to run multiple agents at once, how
  parallel_group works, how to fan out tasks, or why a gate blocked after parallel
  workers.
---

# Parallel Fan-Out in the spin Harness

## The mechanism this skill fronts

Parallel execution in Spindle is not a policy imposed by the command author — it is
a structural property of the artifact dependency graph. The engine is
`ArtifactGraph.getNextArtifacts(completed)` in
`src/core/artifact-graph/graph.ts`, which runs a Kahn topological sort and returns
every artifact whose `requires[]` entries are all satisfied. The `nextHandler` in
`src/commands/handlers.ts` maps those ids to `{ id, model, parallel_group }` tuples
(lines 210-212). Artifacts that share the same `parallel_group` string (declared in
the schema's `ArtifactSchema`, `src/core/artifact-graph/types.ts` line 30) land
together in the `spin next` ready list — that is the signal to fan them out in ONE
message.

`spin` makes the parallelism decision. You read the output and dispatch accordingly.

For the full exit-code ABI (0/1/2/3), the `spin next → Task → spin complete →
spin gate` loop, and the retry bounded by `build_retry_cap`, see the
**harness-protocol** skill. This skill covers only what is specific to fan-out:
when the same `parallel_group` appears, what that means in practice, how failure
isolation works across siblings, and a known gap you must compensate for manually.

---

## Group completeness: `spin fanout-check`

The phase gates (`src/core/gates/`) do not themselves read `parallel_group` — they
check artifacts, file presence, schema validity, and criteria coverage. So a phase
gate run while a sibling is still in flight (or was silently dropped) could pass on
partial work. **`spin fanout-check` closes that hole:** it reads the run-ledger and
the graph (via `fanoutCheckHandler` in `src/commands/handlers.ts`, using
`getAllArtifacts().parallel_group`) and exits `1` if any `parallel_group` is partially
complete — started but not finished — naming the dropped members
(`incomplete-group:<group>:<id>`).

**Run it before the phase gate:**

```bash
spin fanout-check     # exit 0: every group is all-or-nothing complete; exit 1: a sibling was dropped
spin gate <gateId>    # only after fanout-check is green
```

It is a check command, not yet auto-invoked by the gates — the command runs it at the
boundary (the same way it runs `spin complete` for every sibling). A failed
`spin complete` (exit 1) still triggers that artifact's retry loop; `fanout-check` is
the deterministic backstop proving no sibling silently vanished.

**The ledger mode's blind spot — and the file-level mode that closes it.** Ledger
mode only sees `parallel_group` members that are LEDGER artifacts. When the fan-out
happens below ledger granularity — the SDD build phase is ONE ledger artifact
(`build`), but /build dispatches one worker per design-manifest file — the group has
a single member and a dropped per-file worker is invisible: its `build-task` sidecar
simply never exists, so there is nothing for `spin handoff-check` to fail. The
`--manifest` mode compares the design handoff's `manifest[]` against the per-file
`build-task` sidecars on disk (joined on each sidecar's `file` field):

```bash
spin fanout-check --manifest .spindle/features/<feature>/.handoffs/design.json [--handoffs <dir>]
# exit 0: every manifest file has a build-task sidecar
# exit 1: partial fan-out — `missing[]` holds the full manifest entries with no
#         sidecar, i.e. the exact re-dispatch list
# exit 2: malformed manifest / nonexistent handoffs dir (a bug in the invocation)
```

`--handoffs` defaults to the active feature's `.handoffs/`. This is accounting plus
a verdict, never reassignment: the CLI names the dropped units; the orchestrating
command re-dispatches ONLY those via Task (bounded by `spin retry`), then re-runs
the check. /build runs this after all per-file workers return and before
aggregating the build-report.

---

## Lane Matrix

| Lane | When | `spin next` behavior |
|------|------|---------------------|
| **Parallel** | Artifacts are independent (no dependency edge between them) | Same `parallel_group` — dispatch ALL in ONE message |
| **Sequential** | Artifact B reads A's output | Different `parallel_group` or none — B appears only after `spin complete A` succeeds |
| **Retry loop** | A worker's handoff fails validation | `spin retry <id> --inc` re-dispatches; `--ok` exits 1 at `build_retry_cap` ceiling |
| **Gate-blocked** | A gate exits 1 | STOP, surface `{gate, passed, reasons, unmet}`; do not advance |

Mixing lanes is fine within one workflow step: some artifacts in the ready set may
share a `parallel_group` while others depend on their output and will not appear
until those are complete.

---

## When to parallelize vs sequence

**Parallelize** when ALL of these are true:
- The artifacts do not read each other's output files.
- `spin next` places them in the same `parallel_group`.

**Sequence** when ANY of these is true:
- A dependency edge exists — B's prompt or handoff schema references A's artifact path.
- A gate must pass before the next phase starts (gates are always sequential checkpoints).
- `spin next` returns only one artifact, or items carry distinct `parallel_group` values.

Never infer dependency from topic similarity. `spin next` is the authority.

---

## Fan-out protocol

```bash
# 1 — ask what is ready
spin next
# -> { ready: [
#       { id: "DEFINE",     model: "opus",   parallel_group: "phase-define" },
#       { id: "BRAINSTORM", model: "sonnet", parallel_group: "phase-define" }
#     ], blocked: {}, complete: false }
```

Shared `parallel_group: "phase-define"` — dispatch both in ONE message.

```bash
# 2 — route each kind (optional override of the model hint from spin next)
spin route define-intent   # -> { tier: "OPUS",   model: "...", reason: "..." }
spin route spec-authoring  # -> { tier: "SONNET", model: "...", reason: "..." }
```

```
# 3 — fan out: ONE Task message, two workers
#   Worker A writes DEFINE.md    + .spindle/features/<feature>/.handoffs/DEFINE.json
#   Worker B writes BRAINSTORM.md + .spindle/features/<feature>/.handoffs/BRAINSTORM.json
```

```bash
# 4 — validate and record each artifact independently (do NOT skip either)
spin complete DEFINE     --handoff .spindle/features/<feature>/.handoffs/DEFINE.json
spin complete BRAINSTORM --handoff .spindle/features/<feature>/.handoffs/BRAINSTORM.json

# 5 — only after BOTH are in a terminal state, run the phase gate
spin gate G_DEFINE
# exit 0 -> advance.   exit 1 -> STOP, surface, do not advance.
```

Never call `spin complete` without `--handoff` when a handoff schema applies.
Never call `spin gate` while a sibling in the group is still pending.

---

## Typed handoffs

Every worker writes a JSON sidecar. `spin complete <id> --handoff <file>` validates
it against the artifact's `handoff` schema id (inside `completeHandler` in
`src/commands/handlers.ts`) before marking the artifact complete (G_HANDOFF). The
harness-protocol skill lists all schema ids.

Validate a sidecar without marking complete:

```bash
spin handoff-check define .spindle/features/my-feature/.handoffs/define.json
# exit 0 = schema valid;  exit 1 = schema invalid with reasons
```

---

## Failure isolation

Each artifact is an independent unit. A failed or invalid handoff on one sibling
does not abort others in the same `parallel_group`.

1. Run `spin complete` independently for each artifact.
2. On exit 1: `spin retry <id> --inc` increments the counter for THAT artifact only
   (counter lives in `run.json` via `incRetry`/`getRetry` in
   `src/core/run/run-state.ts`); re-dispatch the worker via Task.
3. `spin retry <id> --ok` exits 1 when the counter reaches `config.build_retry_cap`
   — surface the failure to the user, do not re-dispatch.
4. Call `spin gate` only after every sibling has reached a terminal state (complete
   or failed-at-ceiling). The gate aggregates all outcomes and returns a single exit
   code for the phase.
5. A gate exit 1 blocks the entire workflow — no artifact from a later phase may be
   dispatched until the gate clears.

```bash
# Bounded retry for one artifact in a fan-out group
spin retry BUILD_FOO --inc   # exit 0 -> re-dispatch
spin retry BUILD_FOO --inc   # exit 0 -> re-dispatch
spin retry BUILD_FOO --ok    # exit 1 at ceiling -> surface to user, stop
```

---

## Model routing for parallel workers

Run `spin route <kind>` for each artifact before dispatching. Siblings in the same
fan-out may land on different tiers — that is expected.

| Kind examples | Tier |
|---|---|
| `file-read`, `template-fill`, `frontmatter-parse` | HAIKU |
| `spec-authoring`, `design-synthesis`, `code-build`, `kb-concept` | SONNET |
| `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge` | OPUS |

Hard rules:
- Under `--budget low`, downgrade only where a deterministic gate backstops the output.
- The verifier/adversary must be at or above the generator's tier on any CRITICAL gate.
- Critical kinds (`adversary`, `architect`, `review-judge`, `*-intent`) never downgrade.

For the full routing policy, see the **model-routing** skill.

---

## Gate sequence (quick reference)

```
/define  ->  spin gate G_DEFINE        (DEFINE sections + AC-n ids + define handoff valid)
/design  ->  spin gate G_DESIGN        (manifest table + design handoff)
/build   ->  spin gate G_BUILD         (every manifest file on disk + criteria-diff empty + BUILD_REPORT)
/ship    ->  spin gate G_SHIP          (define.criteria minus build.passed must be empty)
/review  ->  spin gate G_REVIEW_BLOCK  (surviving CRITICAL findings > 0 -> block)
```

`G_REVIEW_BLOCK` lives in `src/core/gates/review-gate.ts` (`gReviewBlock`):
it counts surviving CRITICAL findings after the adversarial pass and blocks if
`critical.length > 0`. It does NOT read `parallel_group`.

Check unmet criteria between phases:

```bash
spin diff-criteria --define .spindle/features/my-feature/DEFINE.md \
                  --build  .spindle/features/my-feature/BUILD_REPORT.md
# exit 0 if unmet[] is empty;  exit 1 with the unmet list
```

---

## Anti-patterns

| Anti-pattern | Why it breaks | Correct approach |
|---|---|---|
| Dispatching parallel siblings sequentially | Wastes wall time; misrepresents the concurrency model | Fan out all same-`parallel_group` artifacts in ONE message |
| Calling `spin gate` before all siblings reach a terminal state | Gate sees partial work | Run `spin fanout-check` (exit 1 on a dropped sibling) before gating, after every `spin complete` / retry-ceiling |
| Aggregating the build-report while a per-file worker is missing | Ledger mode cannot see sub-ledger fan-out — the hole ships silently | Run `spin fanout-check --manifest <design.json>` first; re-dispatch exactly `missing[]`, bounded by `spin retry` |
| `spin complete <id>` without `--handoff` | Skips schema validation; G_HANDOFF will block | Always pass `--handoff <sidecar>` when the artifact declares a `handoff` schema |
| Advancing to the next phase without calling `spin gate` | Skips the deterministic checkpoint; may ship invalid artifacts | Gate every phase boundary; branch strictly on exit code |
| Retrying without `spin retry --ok` | Infinite loop on permanent failures | Use `--inc` / `--ok` against `build_retry_cap` |
| Inferring dependency from topic similarity | Wrong sequencing | Trust `spin next` and `parallel_group` exclusively |
| Dispatching workers from outside a command (e.g., node script) | Fake-dispatch anti-pattern — model runs outside the command layer | Workers are always dispatched via the Task tool inside slash commands |
