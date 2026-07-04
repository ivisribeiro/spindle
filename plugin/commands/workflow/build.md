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

If `complete` is already `true`, skip to step 7 (gate). Otherwise read the
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
mark anything complete by hand. Run **per worker**:

```bash
spin handoff-check build-task .spindle/features/<feature>/.handoffs/<file-id>.json
```

- exit `0` → that build unit's handoff is valid. Move on.
- exit `1` → handoff invalid OR verification failed. Enter the **bounded retry
  loop** for the build phase:

```bash
# count this failed attempt against config.build_retry_cap
spin retry build --inc
# check the ceiling — exit 1 means we've hit the cap
spin retry build --ok
```

Loop semantics (the cap lives in `config.build_retry_cap`, enforced by the CLI):

- `spin retry build --inc` increments the build attempt counter.
- `spin retry build --ok` exits `0` while there's headroom, exits `1` at the
  ceiling.
- While `--ok` is `0`: re-dispatch that single `build-worker` (sonnet,
  code-build) with the failure reasons, get a fresh file + `build-task`
  sidecar, and re-run `spin handoff-check build-task …`.
- When `--ok` exits `1`: **STOP retrying.** Do not fake completion —
  surface the unresolved failure to the user. A unit that never passes
  `spin handoff-check build-task` will leave `G_BUILD` red, which is the
  correct outcome.

Re-run `spin next` after the group drains to confirm there's nothing left ready.

---

## 5. File-level fanout check — prove no worker was silently dropped

`spin handoff-check` only validates the sidecars that EXIST. A worker that never
returned leaves no sidecar to fail, and the ledger cannot see it either — the
whole build phase is one ledger artifact. Before aggregating the build-report,
make the CLI compare the design manifest against the per-file `build-task`
sidecars on disk:

```bash
spin fanout-check --manifest .spindle/features/<feature>/.handoffs/design.json
```

(`--handoffs <dir>` overrides the sidecar directory; it defaults to the active
feature's `.handoffs/`.)

- exit `0` → every manifest file is accounted for by a `build-task` sidecar.
  Proceed to aggregate the build-report.
- exit `1` → partial fan-out: at least one per-file worker was dropped. The
  JSON's `missing[]` lists exactly the manifest entries with no sidecar — that
  is your re-dispatch list. **STOP — do not aggregate.** Re-dispatch ONE
  `build-worker` per `missing[]` entry (all in a single Task message), through
  the normal path (worker → sidecar → `spin handoff-check build-task …`),
  bounded by the same ceiling as step 4:

  ```bash
  spin retry build --inc
  spin retry build --ok    # exit 1 at ceiling → STOP, surface, do not fake completion
  ```

  Then re-run `spin fanout-check --manifest …` until it exits `0` (or the
  retry ceiling stops you — surface the still-missing units to the user).
- exit `2` → the invocation is malformed (bad manifest path / handoffs dir).
  That is a bug in this command, not a gate — fix the call.

---

## 6. Aggregate the build-report handoff and complete the phase

Once every build unit has passed `spin handoff-check build-task` and the
file-level fanout check is green, assemble the phase-level
`build-report` handoff:

```json
{
  "feature": "<feature-slug>",
  "results": [
    { "criterion": "AC-1", "status": "passed", "verified_by": "test/pix.test.ts" },
    { "criterion": "AC-2", "status": "passed", "verified_by": "test/pix.test.ts" }
  ],
  "files_written": [
    ".spindle/features/<feature>/.handoffs/<id>.json",
    "<each real source file produced by the workers>"
  ]
}
```

`results[]` is the per-criterion roll-up across all `build-task` handoffs;
`files_written[]` is the union of every file the workers wrote.

**Two deterministic G_BUILD rules to honor (the spine enforces these — don't fight them):**

- **Only report criteria DEFINE declared.** Every `criterion` MUST be an `AC-n` that
  exists in DEFINE. Reporting a passing criterion DEFINE never declared is **phantom
  set-drift** and `G_BUILD`/`G_SHIP` block on it (`unmet: phantom:AC-n`) — the spine
  catches a build↔define mismatch without anyone disclosing it.
- **Cite your proof with `verified_by`.** Set it to the test FILE that substantiates a
  `passed` criterion. When it looks like a path, `G_BUILD` requires that file to exist on
  disk (`unmet: evidence-missing:AC-n` if not) — so "passed" carries evidence, not a bare
  claim. A command (e.g. `"npm run e2e"`) is accepted but not existence-checked.

**Spec-drift honesty (the AC-content rule).** A gate certifies a criterion *ID*,
not its *text*. If, while building, a worker finds that a criterion's stated
value in DEFINE was **wrong** and implements the correct value instead, it MUST
flag that on the result — never bury the correction in a code comment:

```json
{ "criterion": "AC-1", "status": "passed",
  "corrected_spec": true,
  "correction": "DEFINE said CRC \"1D3D\"; the real CRC-16/CCITT-FALSE of \"123456789\" is \"29B1\"" }
```

This is what stops a green build from silently leaving a false spec behind
(the pix-brcode dogfood finding). `G_SHIP` surfaces these, and
`spin spec-drift --build <report>` exits 1 until DEFINE.md is reconciled.

Persist the report as the BUILD_REPORT, then complete the build artifact through the CLI:

```bash
spin complete build --handoff .spindle/features/<feature>/.handoffs/build.json
```

- exit `1` → the `build-report` failed its schema (the `G_HANDOFF` check inside
  `spin complete`). Fix the report shape and retry. Do not advance.
- exit `0` → the phase artifact is recorded. `spin complete` persists the
  validated handoff canonically to `.handoffs/build.json` — that is the path
  `G_BUILD` and `G_SHIP` read.

---

## 7. G_BUILD — the gate that replaces the checkbox

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
                     --build .spindle/features/<feature>/.handoffs/build.json
  ```

  Fix the cause — re-dispatch the relevant `build-worker`(s) for the unmet
  slice (bounded again by `spin retry build --inc` / `spin retry build --ok`),
  re-aggregate the `build-report`, then **re-gate** with `spin gate G_BUILD`.
  Iterate until green. Never advance on a red gate.

- exit `0` → build is verifiably done. Hand off to **`/ship`** (Phase 4).

---

## Invariants for this command

- `spin` never calls a model; this command is the only place a model runs.
- Workers author; `spin` decides. Branch strictly on exit codes.
- Never mark a build unit or the phase complete by hand — only `spin complete`
  records completion, only `G_BUILD` clears the phase.
- The retry loop is bounded by `config.build_retry_cap` via
  `spin retry build --inc | --ok`; there is no prose "max N retries".
- Fan out the whole `by_manifest_layer` group in a single Task message.
- Run `spin fanout-check --manifest …` before aggregating the build-report — a
  dropped per-file worker is exit 1 with a `missing[]` re-dispatch list, never
  something inferred from prose. The CLI accounts; this command re-dispatches.
- Use only the `spin` commands, gates (`G_DESIGN`, `G_BUILD`, `G_HANDOFF`), and
  handoff ids (`design`, `build-task`, `build-report`, `define`) named here.
