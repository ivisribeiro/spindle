---
name: build
description: Phase 3 — execute the build. Fan out per-file build workers in true parallel from the design manifest, run a bounded verification loop against config.build_retry_cap, aggregate a build-report handoff, and let G_BUILD (file-existence + criteria-diff IN CODE) decide readiness for /ship. There is no self-marked checkbox anymore — G_BUILD is the gate.
---

# /build — Phase 3 (build execution)

Turn the approved design manifest into code. The CLI owns every ordering,
validation, retry, and gate decision; this command only dispatches workers and
branches on `spin` exit codes.

`spin` shorthand = `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js`.

Exit-code ABI you branch on: `0` pass · `1` gate blocked / handoff invalid ·
`2` usage error · `3` internal error.

> **No checkbox.** The old prose ("self-mark the build complete after at most 3
> retries") is GONE. You never declare the build done by hand. `G_BUILD` is the
> sole arbiter — it checks that every manifest file exists on disk, that the
> DEFINE↔BUILD criteria-diff is empty, and that the BUILD_REPORT exists, all IN
> CODE. The bounded loop ceiling lives in `config.build_retry_cap`, not in prose.

---

## 1. Confirm the design phase actually closed (G_DESIGN first)

Never start building on an unapproved design. Gate before anything else:

```bash
spin gate G_DESIGN
```

- exit `1` → **STOP**. Surface `{gate, passed, reasons, unmet}` verbatim. The
  design isn't ready (manifest table or design handoff missing/invalid). Send
  the user back to `/design`. Do not advance.
- exit `0` → design is locked. Proceed.

---

## 2. Ask the CLI what's ready

```bash
spin next
```

Returns `{ ready:[{id,model,parallel_group}], blocked:{}, complete:bool }`.
Build artifacts come back ready with `parallel_group: by_manifest_layer` — that
grouping is your fan-out instruction: independent files/layers run together.

If `complete` is already `true`, skip to step 5 (gate). Otherwise read the
design handoff manifest to enumerate the files/layers to build.

```bash
spin validate design
```

Read `.spindle/features/<feature>/DESIGN.md` and its `.handoffs/design.json`
manifest. Each manifest row is one build unit: a target file (or layer) with its
contract. That row-set is the worker fan-out list.

---

## 3. Fan out one build-worker per manifest file/layer — TRUE PARALLEL

For the build task-kind, confirm the tier (the ready hint says `sonnet`; this
agrees with routing):

```bash
spin route code-build
```

Then dispatch **one `build-worker` subagent per manifest file/layer**, all in a
**single Task message** so they run in true parallel (everything in the
`by_manifest_layer` group goes out together — one message, N `Task` calls).

Each `build-worker` (model: **sonnet**, task-kind: **code-build**) must:

1. Build exactly its assigned manifest file/layer to the contract in the design
   manifest — nothing outside its slice.
2. Write the actual source file(s) to disk.
3. Write a `build-task` JSON handoff sidecar to
   `.spindle/features/<feature>/.handoffs/<id>.json` describing what it produced
   (the file(s) written + which DEFINE criteria its slice satisfies).

Do not narrate the build in prose as a substitute for the file — the file on
disk and the `build-task` handoff are the deliverables.

---

## 4. Validate each worker + bounded verification loop

For every returned `build-task` handoff, validate it through the CLI — never
mark anything complete by hand:

```bash
spin complete <id> --handoff .spindle/features/<feature>/.handoffs/<id>.json
```

- exit `0` → that build unit is recorded in the ledger. Move on.
- exit `1` → handoff invalid OR verification failed. Enter the **bounded retry
  loop** for that `<id>`:

```bash
# count this failed attempt against config.build_retry_cap
spin retry <id> --inc
# check the ceiling — exit 1 means we've hit the cap
spin retry <id> --ok
```

Loop semantics (the cap lives in `config.build_retry_cap`, enforced by the CLI):

- `spin retry <id> --inc` increments the attempt counter.
- `spin retry <id> --ok` exits `0` while there's headroom, exits `1` at the
  ceiling.
- While `--ok` is `0`: re-dispatch that single `build-worker` (sonnet,
  code-build) with the failure reasons, get a fresh file + `build-task`
  sidecar, and re-run `spin complete <id> --handoff …`.
- When `--ok` exits `1`: **STOP retrying that unit.** Do not fake completion —
  surface the unresolved failure to the user. A unit that never passes
  `spin complete` will leave `G_BUILD` red, which is the correct outcome.

Re-run `spin next` after the group drains to confirm there's nothing left ready.

---

## 5. Aggregate the build-report handoff and complete the phase

Once every build unit has passed `spin complete`, assemble the phase-level
`build-report` handoff:

```json
{
  "feature": "<feature-slug>",
  "results": [
    { "criterion": "AC-1", "status": "passed" },
    { "criterion": "AC-2", "status": "passed" }
  ],
  "files_written": [
    ".spindle/features/<feature>/.handoffs/<id>.json",
    "<each real source file produced by the workers>"
  ]
}
```

`results[]` is the per-criterion roll-up across all `build-task` handoffs;
`files_written[]` is the union of every file the workers wrote. Persist it as
the BUILD_REPORT, then complete the build artifact through the CLI:

```bash
spin complete build --handoff .spindle/features/<feature>/.handoffs/build-report.json
```

- exit `1` → the `build-report` failed its schema (the `G_HANDOFF` check inside
  `spin complete`). Fix the report shape and retry. Do not advance.
- exit `0` → the phase artifact is recorded.

---

## 6. G_BUILD — the gate that replaces the checkbox

This is the decision point. No prose, no checkbox — `G_BUILD` verifies, in code,
that every manifest file exists on disk, the criteria-diff is empty, and the
BUILD_REPORT exists:

```bash
spin gate G_BUILD
```

- exit `1` → **STOP.** Surface `{gate, passed, reasons, unmet}` verbatim. The
  `unmet[]` set is exactly the DEFINE criteria the build did not satisfy (and/or
  the missing manifest files). For criteria gaps, you can inspect the raw diff:

  ```bash
  spin diff-criteria --define .spindle/features/<feature>/.handoffs/define.json \
                     --build .spindle/features/<feature>/.handoffs/build-report.json
  ```

  Fix the cause — re-dispatch the relevant `build-worker`(s) for the unmet
  slice (bounded again by `spin retry <id> --inc` / `--ok`), re-aggregate the
  `build-report`, then **re-gate** with `spin gate G_BUILD`. Iterate until green.
  Never advance on a red gate.

- exit `0` → build is verifiably done. Hand off to **`/ship`** (Phase 4).

---

## Invariants for this command

- `spin` never calls a model; this command is the only place a model runs.
- Workers author; `spin` decides. Branch strictly on exit codes.
- Never mark a build unit or the phase complete by hand — only `spin complete`
  records completion, only `G_BUILD` clears the phase.
- The retry loop is bounded by `config.build_retry_cap` via
  `spin retry <id> --inc | --ok`; there is no prose "max N retries".
- Fan out the whole `by_manifest_layer` group in a single Task message.
- Use only the `spin` commands, gates (`G_DESIGN`, `G_BUILD`, `G_HANDOFF`), and
  handoff ids (`design`, `build-task`, `build-report`, `define`) named here.
