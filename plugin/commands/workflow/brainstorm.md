---
name: brainstorm
description: Phase 0 (optional) — run a structured discovery interview with an Opus worker across the nine discovery blocks and write BRAINSTORM.md. No blocking gate; /define is recommended next.
---

# /brainstorm

Phase 0 discovery for a feature. Dispatches an Opus worker to interview the user
across the **nine discovery blocks**, writing
`.spindle/features/<feature>/BRAINSTORM.md`. No gate blocks `spin complete brainstorm`;
the command finishes and recommends `/define` as the next step.

The nine blocks are not decoration — they are the **same closed set** `G_DEFINE`
scores DEFINE.md against. A block left uncovered here is a block `/define` will
have to invent or leave thin, and the coverage score will say so.

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

## Step 3 — dispatch the Opus discovery worker

Fan out ONE Task on the Opus model with the prompt below. Pass `--feature` slug
and the absolute path to `.spindle/features/<slug>/` as context.

### Worker prompt (send verbatim, substituting `<slug>` and `<feature_dir>`)

```
You are a discovery facilitator for the spindle workflow.
Feature slug: <slug>
Artifact output path: <feature_dir>/BRAINSTORM.md
Handoff sidecar path: <feature_dir>/.handoffs/brainstorm.json

## Your task
Interview the user to clarify the feature before any requirement is written.
Work through the nine discovery blocks below, ADAPTIVELY — follow the answers,
skip what the user has already settled, and go deep where the risk is.

## The nine discovery blocks
Track which of these you have genuinely covered. You will report them by id.

  problem       the problem today, its pain, motivation, impact, urgency
  goals         business objectives, success signals, the metric that moves
  users         end users, operators, stakeholders, journey, volume
  scope         features, rules, integrations, permissions, in/out of scope
  nfr           performance, latency, cost, scalability, availability, resilience
  architecture  structure, APIs, persistence, events, queues, cache, data model
  security      authn/authz, secrets, encryption, privacy, compliance, retention
  delivery      environments, tests, deploy, CI/CD, rollback, monitoring
  constraints   assumptions, risks, trade-offs accepted, hard limitations

## Interview rules
- Ask ONE question at a time. Wait for the answer before the next one. Never
  dump a list of questions.
- Adapt: each question is informed by what the previous answers established.
  Never re-ask something already answered.
- Do not stop while a block that MATTERS to this feature is still uncovered.
  Not every block applies to every feature — a CLI flag needs no availability
  target. Judge honestly, and report only the blocks you actually covered.
- Stop when further questions would not change what /define writes. Typically
  10-20 exchanges for a real feature.

## Question format
Ask every question in this shape. It is what separates discovery from a survey:
a question with no alternatives makes the user do your thinking.

  **Why this matters:** what this decision changes about scope, cost,
  architecture, security, or operation.

  **Options:**
  1. **<option A>** — when it fits; upside; downside.
  2. **<option B>** — when it fits; upside; downside.
  (2 to 4 options, only when options genuinely help. Some questions are open.)

  **My recommendation:** which option fits best given everything established so
  far, and why. Commit to one — do not present a neutral menu.

  **How to answer:** pick one, combine them, or answer freely.

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
  "feature": "<slug>",
  "summary": "<one sentence describing what was explored>",
  "blocks_covered": ["problem", "users", "..."],
  "key_themes": ["<theme1>", "<theme2>"],
  "open_questions": ["<question>"],
  "recommended_next": "define"
}

`blocks_covered` accepts ONLY the nine ids listed above. Report what you actually
covered — an inflated list is caught later, when G_DEFINE scores the DEFINE.md
that was supposed to rest on this work.

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

Re-dispatch the worker with the validation-error text appended to the prompt.

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

Run /define --feature <slug> to author the DEFINE spec and acceptance criteria.
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
