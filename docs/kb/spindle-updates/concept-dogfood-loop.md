# dogfood-loop

The method that produced most of the session's value: **use Spindle to improve
Spindle.** A closed feedback loop.

## The loop
1. **Use** Spindle's SDD/audit methodology to plan a real project (erin-ingest):
   a workflow audited 6 domains → a phased plan (4 phases, 27 tasks) → an Opus
   adversary evaluated it (`needs-fixes`, 0.83) → the fixes were applied.
2. **Capture** the friction: 39 items logged (`DOGFOOD_LOG_erin-planning.md`) —
   places where the tool was awkward (no audit artifact, doc-vs-code drift,
   no ops-readiness bucket, no plan-quality gate, …).
3. **Convert** friction into improvements: 10 proposals
   (`IMPROVEMENTS_FROM_DOGFOOD.md`), all implemented.
4. **Ship** them back into Spindle — the suite grew **93 → 189 tests**, still green.

## What the loop surfaced
- The biggest cost lesson (~8.8M tokens) became the `spin tier` discipline
  (see `orchestration-tiers`).
- The adversary's strongest contribution was *omitted* tasks (no regression test,
  no idempotency check) — encoded as a fixed omission checklist in the
  `adversarial-gate` skill.

## Why it matters
A tool that plans real work surfaces its own weak points faster than any spec
review. The friction log is the requirements doc for the next iteration.
