# Spindle workflow

Run this procedure from the project root. Every `spin` example uses the project
runtime. Replace the leading `spin` with `node .spindle/harness/bin/spin.js`.
Resolve the feature slug from `spin state`. Use the paths declared in the active
schema. The examples below use the bundled SDD schema and refer to
`.spindle/features/<slug>` as the feature directory and its `.handoffs` subdirectory
as the handoff directory. Example handoffs are in
`.spindle/harness/schemas/handoffs/examples/`. Substitute actual paths for
placeholders before invoking commands.

Execute the requested phase. With no phase, use status. Use the exit code of
each invocation and its JSON. Exit 0 permits the next step, exit 1 blocks the
phase or triggers a bounded repair where specified, exit 2 is a usage error and
exit 3 stops execution for diagnosis. Report available `reasons`, `unmet`, and
`errors` with the artifact path and the next action. Use only the CLI to update
the run ledger. Keep artifact authoring and verification in the coding host.

When a step uses a worker, call `spin route <kind>` to see the intended tier.
The returned model label is a Claude model hint. In other hosts, map the tier to
an available model only when the host supports model selection and the mapping is
known. Use an authorized native delegation tool when it is available. Assign
disjoint work to parallel workers and keep dependent work sequential. Otherwise,
perform the authoring in the current session and report that authoring or tier
selection was handled there. Workers return files and evidence to the session
coordinating the phase. That session runs the CLI and owns phase transitions.

Before authoring a phase, use `spin next` and require the artifact in `ready[]`.
Each preceding phase gate below runs before this readiness check. If the artifact
is already complete, use the ledger and re-run its phase gate to diagnose the
current state. For edits to a recorded artifact, follow **Iterate**. Treat
`detected_on_disk` as a signal for recovery. Check that any recovered files match
the active feature and validate them before completing.

On artifact validation or build verification failures, report the failure and use
`spin retry <id> --ok` to check the ceiling. If it exits 0, record the retry with
`spin retry <id> --inc`, then repair the failed work and repeat its validation.
Stop when either command blocks, with the last validation errors. On a failed
phase gate, stop before the next phase and report the blocker. Resume the same
phase after the underlying artifact or evidence is repaired.

## Init and status

For a requested new SDD run, validate the requested feature slug as kebab-case,
then run `spin init --schema sdd --feature <slug>`. Use the active run if its
feature already matches. If another active run exists, present its feature and
stop. Starting over with `--force` is a decision for the user to carry out in
their terminal.

For status, use `spin state` and `spin next`. Report completed artifacts, relevant
blockers, and the next Spindle phase. `spin trace` can provide the event history.
If there is no active run, show how to initialize one. This procedure covers the
SDD schema. For a different active schema, report it and stop before writing SDD
artifacts.

## Brainstorm

Optional before Define. Use the `define-intent` routing kind. Clarify the problem,
goals, users, scope, non-functional requirements, architecture, security,
delivery, and constraints, asking one material question at a time. Write
`BRAINSTORM.md` with Problem Space, Goals, Non-Goals, Personas / Users, Key
Questions Answered, Open Questions, Risks & Constraints, and Signal for Success.
Write `brainstorm.json` in the handoff directory using the bundled example and
record the discovery blocks actually covered. Run
`spin handoff-check brainstorm <brainstorm.json>`, then `spin complete brainstorm`.
Recommend Define. Skipping discovery leaves brainstorm pending in the ledger
without blocking Define.

## Define

Use the `define-intent` routing kind. Write `DEFINE.md` with H2 sections
`Why`, `What`, and `Acceptance Criteria`. Capture testable criteria with stable
`AC-n: <criterion>` IDs. Write `define.json` in the handoff directory with the
feature, clarity score from 0 to 1, criterion IDs, and any open questions.
Run `spin validate define`, then `spin complete define --handoff <define.json>`
and `spin gate G_DEFINE`. Surface any discovery coverage gaps returned by the
CLI. On pass, recommend Design.

## Design

Run `spin gate G_DEFINE` and check Design readiness. Use the `design-intent`
routing kind. Read the completed DEFINE. Write `DESIGN.md` with H2 sections
`Overview`, `File Manifest`, and `Decisions`. Use a table with `File`, `Action`,
and `Purpose` columns. List each repository-relative file the build will create
or modify. Write `design.json` in the handoff directory with the same manifest
and the design decisions. Run `spin validate design`, then
`spin complete design --handoff <design.json>` and `spin gate G_DESIGN`.
On pass, recommend Build.

## Build

Run `spin gate G_DESIGN` and check Build readiness. Use the `code-build` routing
kind. Implement the design manifest in independent file slices where practical.
For each file, record a separate build-task JSON sidecar in the handoff directory
using the bundled example. Set `file` to the exact manifest path. Give each
sidecar a distinct name such as `build-task-1.json` and validate it with
`spin handoff-check build-task <task.json>`. After the work returns, run
`spin fanout-check --manifest <design.json>`. An exit 1 reports the missing
manifest files. Recover those files and handoffs within the shared build retry
ceiling before aggregating the report.

Run project tests and the verifiers tied to the acceptance criteria. Record
actual outcomes in `BUILD_REPORT.md` and `build.json`. Use the declared
criterion IDs, mark a criterion `passed` only with evidence, and record the test
file or command in `verified_by`. Disclose any corrected spec value with
`corrected_spec: true` and a concrete `correction`. If relevant verification
fails, repair it within the build retry ceiling or report the blocker. Run
`spin complete build --handoff <build.json>` and `spin gate G_BUILD`.
On pass, recommend Ship and explain the human approval step.

## Iterate

For a requested edit to a phase artifact or its evidence, identify its artifact
ID with `spin schema show`. Before editing, run `spin invalidate <id>`. This
clears that artifact and its downstream closure from the ledger and revokes
recorded gate verdicts and human approval. Apply the requested change to the
artifact and its handoff together. Resume with `spin next` and the relevant phase
procedure, refreshing downstream artifacts and running their gates. When code
or verification changes after Build, invalidate `build` and rerun Build before
seeking approval again. When the design changes, invalidate `design` and start
there.

## Ship

Run `spin gate G_BUILD` and
`spin diff-criteria --define <define.json> --build <build.json>`.
Check `spin schema show` and, if `config.max_tokens` is set, run
`spin budget --enforce`. This uses reported token counts. Inspect
`spin spec-drift --build <build.json>`. If drift is present, reconcile the
affected acceptance criteria using Iterate, preserve the correction and its
acknowledgment (`reconciled: true`) in the rebuilt handoff, then re-run the
gates. Reconciliation requires fresh human approval.

Run `spin gate G_SHIP`. If approval is missing, report the blocker and have the
user run `node .spindle/harness/bin/spin.js approve` in their own interactive
terminal from the project root. Never run approval on the user’s behalf,
including via a pseudo-terminal. Resume Ship after the user approves.

Once `G_SHIP` passes and `spin next` shows Ship ready, use the `ship-prose`
routing kind to write `SHIPPED.md` and `LESSONS.md` from the recorded files,
criteria, and verification evidence. Run `spin complete ship`. Report archive
paths and the gate verdict. Shipping here records the archive and sign-off.
Any publishing, merge, or deployment is a separate operation.
