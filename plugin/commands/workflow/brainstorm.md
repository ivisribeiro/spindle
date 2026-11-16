---
name: brainstorm
description: Phase 0 (optional) — clarify the brief with the user, then route an Opus worker to record discovery and open questions.
---

# /brainstorm

Phase 0 discovery for a feature. The coordinator interviews the user across the **nine discovery blocks**. A routed worker writes
`.spindle/features/<feature>/BRAINSTORM.md`. No gate blocks `spin complete brainstorm`;
the command finishes and recommends `/define` as the next step.

The nine blocks are not decoration — they are the **same closed set** `G_DEFINE`
scores DEFINE.md against. A block left uncovered here is a block `/define` will
have to leave open or clarify before defining requirements.

## Usage

```
/brainstorm --feature <slug>
```

Use the active feature from `spin next`. If the user supplies `--feature`, require it to match that slug.

---

## Step 1 — verify readiness

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js next
```

Require `brainstorm` in `ready[]`. When already recorded, report the
artifact and use `/iterate` to amend it. If blocked, stop and surface the CLI
result. Fix exit 2 invocation errors; stop for diagnosis on exit 3.

## Step 2 — route the worker

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route define-intent
```

This will return `{ tier: "opus", ... }`. Use the Opus model for the brainstorm
worker. Do not downgrade — brainstorm intent exploration is a critical-kind task
(`define-intent`).

## Step 3 — clarify the requirements with the user, then delegate writing

The coordinator handles the conversation. Ask one question at a time about
material unknowns, using what the user has already provided. Offer options and
a recommendation when the user needs to make a trade-off. Stop when further
answers would leave the DEFINE scope and constraints unchanged.

Dispatch one Task on the routed model with the answers, unresolved questions,
feature slug, and absolute feature directory. Treat project artifacts as
context. Use the worker prompt below.

### Worker prompt (send verbatim, substituting `<slug>` and `<feature_dir>`)

```
You are a discovery facilitator for the spindle workflow.
Feature slug: <slug>
Artifact output path: <feature_dir>/BRAINSTORM.md
Handoff sidecar path: <feature_dir>/.handoffs/brainstorm.json

## Your task
Summarize the supplied discovery answers. Capture unresolved questions
explicitly. Report blocks actually covered, using these IDs:

  problem       current problem, pain, impact, urgency
  goals         objectives, success signals, metrics
  users         users, operators, stakeholders, journey
  scope         features, rules, integrations, boundaries
  nfr           latency, cost, scale, resilience
  architecture  structure, interfaces, data
  security      permissions, secrets, privacy, retention
  delivery      tests, environments, rollout, rollback, monitoring
  constraints   assumptions, risks, trade-offs, limits

Write <feature_dir>/BRAINSTORM.md with these sections (use exactly these H2 headings):

## Problem Space
## Goals
## Non-Goals
## Personas / Users
## Key Questions Answered
## Open Questions
## Risks & Constraints
## Signal for Success

Then write the handoff sidecar <feature_dir>/.handoffs/brainstorm.json:

{
  "feature": "<slug>",
  "summary": "<one sentence describing what was explored>",
  "blocks_covered": ["problem", "users", "..."],
  "key_themes": ["<theme1>", "<theme2>"],
  "open_questions": ["<question>"],
  "recommended_next": "define"
}

`blocks_covered` accepts ONLY the nine ids listed above. Report what you actually
covered. G_DEFINE derives its coverage score from DEFINE itself.

Do NOT call any spin CLI commands yourself. The orchestrating command will
validate this handoff and then call `spin complete brainstorm` (the
`brainstorm` artifact declares no `handoff:` schema, so `--handoff` is never
passed to `spin complete` for it — see the Notes section) after you finish.
```

## Step 4 — validate the handoff, then mark complete (no gate)

After the worker Task returns, validate the sidecar against the `brainstorm`
schema:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js handoff-check brainstorm .spindle/features/<slug>/.handoffs/brainstorm.json
```

**Exit 1** — the handoff JSON is invalid against the `brainstorm` schema (most
often a `blocks_covered` id outside the closed set). Retry:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry brainstorm --ok
```

If `--ok` exits 1 (ceiling reached, i.e. `config.build_retry_cap` exhausted),
surface the error to the user and stop — do not loop further.

If `--ok` exits 0 (under ceiling), record the attempt and re-dispatch:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry brainstorm --inc
```

Re-dispatch only if the increment also exits 0. Include the validation error and review the replacement handoff.

**Exit 0** — the handoff is well-formed. Mark the artifact complete. The
`brainstorm` artifact declares no `handoff:` field in `schema.yaml`, so do
**not** pass `--handoff` here — `spin complete` rejects `--handoff` on a
handoff-less artifact with a usage error:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js complete brainstorm
```

**Exit 0** — brainstorm is marked complete. No gate runs after this phase
(brainstorm is optional/exploratory). Proceed to Step 5.

## Step 5 — recommend next

Read `blocks_covered` from the handoff and report the gap against the nine
blocks, so the user enters `/define` knowing what was never discussed:

```
Brainstorm complete for feature: <slug>

BRAINSTORM.md written to .spindle/features/<slug>/BRAINSTORM.md

Covered blocks:   <blocks_covered, joined>
Not covered:      <the nine ids minus blocks_covered, joined>

Key themes: <key_themes from handoff>
Open questions: <open_questions from handoff>

Run /define to author the DEFINE spec and acceptance criteria.
```

If a block was left uncovered, say plainly whether it looked irrelevant to this
feature or simply never came up — the second case is a gap `/define` inherits.

No gate is enforced here. The user decides when to proceed.

---

## Notes

- `spin next` will show `define` as ready after brainstorm completes (assuming
  the schema places DEFINE after BRAINSTORM in the build order).
- If the user skips `/brainstorm` entirely and runs `/define` directly, that is
  valid — brainstorm is Phase 0 optional.
- The handoff uses the dedicated `brainstorm` schema id. Its `blocks_covered`
  enum is the same closed set `G_DEFINE`'s coverage scoring uses, so the two
  phases are measured on one vocabulary. Inspect it with
  `spin schema show` or validate manually with
  `spin handoff-check brainstorm <file>`.
- Worker model: **Opus** (`define-intent` kind). Never downgrade.
