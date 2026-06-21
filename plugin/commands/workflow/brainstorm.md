---
name: brainstorm
description: Phase 0 (optional) — run a one-question-at-a-time collaborative brainstorm with an Opus worker and write BRAINSTORM.md for the feature. spin complete brainstorm has no blocking gate; /define is recommended next.
---

# /brainstorm

Phase 0 brainstorm for a feature. Dispatches an Opus worker to explore the
problem space through collaborative dialogue, writing
`.spindle/features/<feature>/BRAINSTORM.md`. No gate blocks `spin complete brainstorm`;
the command finishes and recommends `/define` as the next step.

## Usage

```
/brainstorm --feature <slug>
```

`--feature` is required. The slug must match an existing `.spindle/features/<feature>/`
directory (created by `spin init`).

---

## Step 1 — verify readiness

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js next
```

Parse the JSON response. Confirm `brainstorm` appears in `ready[].id` or that
the feature directory exists. If the `complete` field is already `true` (all
artifacts done), surface that and stop.

If `brainstorm` is already in `state.completed[]` (from
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js state`), warn the user and ask
whether to re-run. If they say no, stop.

## Step 2 — route the worker

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js route define-intent
```

This will return `{ tier: "opus", ... }`. Use the Opus model for the brainstorm
worker. Do not downgrade — brainstorm intent exploration is a critical-kind task
(`define-intent`).

## Step 3 — dispatch the Opus brainstorm worker

Fan out ONE Task on the Opus model with the prompt below. Pass `--feature` slug
and the absolute path to `.spindle/features/<slug>/` as context.

### Worker prompt (send verbatim, substituting `<slug>` and `<feature_dir>`)

```
You are a brainstorm facilitator for the spindle workflow.
Feature slug: <slug>
Artifact output path: <feature_dir>/BRAINSTORM.md
Handoff sidecar path: <feature_dir>/.handoffs/brainstorm.json

## Your task
Conduct a collaborative one-question-at-a-time brainstorm with the user to
clarify the feature's problem space, goals, constraints, and open questions.

Rules:
- Ask ONE focused question at a time. Wait for the answer before asking the next.
- Do not dump a list of questions. One at a time is the UX.
- Cover: user problem, intended users/personas, success signals, known constraints,
  edge cases, risks, and anything that would be essential for /define to write
  strong acceptance criteria.
- Stop asking when you have enough to write a thorough BRAINSTORM.md. Typically
  5–10 exchanges; use judgment.

## After the dialogue
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
  "handoff_schema": "define",
  "feature": "<slug>",
  "summary": "<one sentence describing what was explored>",
  "key_themes": ["<theme1>", "<theme2>"],
  "open_questions": ["<question>"],
  "recommended_next": "define"
}

(Using schema id "define" — the brainstorm output feeds directly into /define.)

Do NOT call any spin CLI commands yourself. The orchestrating command will call
`spin complete brainstorm --handoff <sidecar>` after you finish.
```

## Step 4 — mark complete (no gate)

After the worker Task returns, call:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js complete brainstorm \
  --handoff .spindle/features/<slug>/.handoffs/brainstorm.json
```

**Exit 0** — brainstorm is marked complete. No gate runs after this phase
(brainstorm is optional/exploratory). Proceed to Step 5.

**Exit 1** — the handoff JSON is invalid against the `define` schema. Retry:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry brainstorm --ok
```

If `--ok` exits 1 (ceiling reached, i.e. `config.build_retry_cap` exhausted),
surface the error to the user and stop — do not loop further.

If `--ok` exits 0 (under ceiling), record the attempt and re-dispatch:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js retry brainstorm --inc
```

Re-dispatch the worker with the validation-error text appended to the prompt.

## Step 5 — recommend next

Display a brief summary:

```
Brainstorm complete for feature: <slug>

BRAINSTORM.md written to .spindle/features/<slug>/BRAINSTORM.md

Key themes: <key_themes from handoff>
Open questions: <open_questions from handoff>

Run /define --feature <slug> to author the DEFINE spec and acceptance criteria.
```

No gate is enforced here. The user decides when to proceed.

---

## Notes

- `spin next` will show `define` as ready after brainstorm completes (assuming
  the schema places DEFINE after BRAINSTORM in the build order).
- If the user skips `/brainstorm` entirely and runs `/define` directly, that is
  valid — brainstorm is Phase 0 optional.
- The handoff uses schema id `define` (not a dedicated `brainstorm` schema) because
  the output feeds the DEFINE phase. `spin handoff-check define <file>` can be used
  to validate manually.
- Worker model: **Opus** (`define-intent` kind). Never downgrade.
