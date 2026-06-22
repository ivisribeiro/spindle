---
name: update-kb
description: Refresh or extend an existing KB domain through the spin harness — re-validate structure and coverage, add new concepts via the same gated parallel fan-out, replace stale concepts, and mark unreachable concepts without silently dropping anything. Reuses G_KB_STRUCTURE, G_KB_COVERAGE, and the kb-concept-worker; invents no new gates or handoff ids.
---

# /update-kb

Refresh or extend an existing KB domain. This command assumes the domain has
already been created by `/create-kb`. It re-validates what is there, authors
new or replacement concepts, and marks staleness — it never silently drops a
concept or bypasses the gates.

Shorthand: `spin <args>` ≡ `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>`.
Exit-code ABI: `0` pass · `1` gate blocked / handoff invalid · `2` usage · `3` internal.

## Inputs

- `<domain>` — the KB domain slug (required). Must already exist under
  `.spindle/features/<domain>/`.
- `--add <slug>[,<slug>...]` — add one or more new concept slugs to the domain.
- `--replace <slug>[,<slug>...]` — re-author one or more existing concepts
  (concept page + sidecar are overwritten; not a remove + re-add).
- `--mark-stale <slug>[,<slug>...]` — mark concepts as stale without re-authoring.
  Adds a `<!-- stale_since: <date> -->` comment to the concept file and sets
  `"needs_decoding": true` on the sidecar. The concept remains in the manifest
  and in gate coverage — it is not removed.
- `--audit` — re-run gates only, no authoring (same as `/create-kb --audit`).

At least one of `--add`, `--replace`, `--mark-stale`, or `--audit` is required.
Multiple flags may be combined. `--audit` runs first, then authoring.

## 0. Pre-flight — validate the existing domain

Before any changes, confirm the existing KB is structurally sound:

```
spin state
```

- Exit `2` (no run state) → the domain has no active run in `.spindle/`. Run
  `/create-kb <domain> --audit` to inspect it as a legacy KB, or
  `/create-kb <domain>` to initialize from scratch. Stop here.
- Exit `0` → parse `schema`, `feature`, `completed[]`, `gates{}`.

If the active run's `feature` does not match `<domain>`, surface the mismatch
and stop. Do not overwrite a run for a different feature.

Run the structure gate:

```
spin gate G_KB_STRUCTURE
```

- Exit `1` → the existing KB is broken. Surface `{gate,passed,reasons,unmet}`,
  STOP, and tell the user to repair the domain via `/create-kb <domain>` before
  updating. Do not proceed with authoring on a broken base.
- Exit `0` → structure is sound. Proceed.

## 1. Audit mode (`--audit`)

If `--audit` is the only flag, stop after the gates:

```
spin gate G_KB_STRUCTURE
spin gate G_KB_COVERAGE
```

Report each gate's exit code and, on exit `1`, its `{reasons,unmet}` with enough
detail for the user to decide whether to repair with `--replace` or `--add`.
Then surface the run trace:

```
spin trace
```

## 2. Mark stale (`--mark-stale`)

For each slug in `--mark-stale`:

1. Confirm the concept file exists at `.spindle/features/<domain>/concept-<slug>.md`.
   If missing, surface an error and skip (do not silently ignore).
2. Add a staleness notice at the top of the concept file (just below the H1):
   ```markdown
   > **Stale** — marked stale on <ISO date>. Re-author with `/update-kb <domain> --replace <slug>`.
   ```
3. Update the sidecar at `.handoffs/kb-concept-<slug>.json`:
   - Set `"needs_decoding": true`.
   - Add `"stale_since": "<ISO date>"` at the top level (additive field; ignored
     by `kb-concept` schema validation, visible in the gate's `needs_decoding`
     surfacing).
4. Do NOT remove the concept from `manifest.json`. Stale concepts stay in
   coverage — the gate surfaces them as `needs_decoding` debt, not as missing.

## 3. Replace existing concepts (`--replace`)

For each slug in `--replace`:

1. Confirm the concept exists in `manifest.json`. If not, reject: a
   `--replace` on an undeclared slug is an error (use `--add` instead).
2. Dispatch one `kb-concept-worker` via Task for that slug (same inputs as
   `/create-kb` Wave B — `FEATURE`, `CONCEPT`, `SCHEMA_PATH`).
3. The worker overwrites `concept-<slug>.md` and `.handoffs/kb-concept-<slug>.json`.
4. Do NOT call `spin complete` per worker. After all replacement workers finish,
   call `spin complete concepts` once (see step 5).

Dispatch all replacement workers **in a single Task message** for true parallelism.

## 4. Add new concepts (`--add`)

Adding new concepts requires updating the manifest first, then authoring:

### 4.1 Read and update `manifest.json`

Read `.spindle/features/<domain>/manifest.json`. Append each new slug:

```json
{ "concepts": [ ...existing..., { "slug": "<new-slug>" } ] }
```

Write the updated manifest. Do NOT remove any existing slug from `manifest.json`
— removing a slug from the manifest with an existing concept file would cause
`G_KB_COVERAGE` to report an orphaned file, which is confusing and not the same
as intentionally retiring a concept.

### 4.2 Dispatch new concept workers

Dispatch one `kb-concept-worker` per new slug, **in a single Task message**.
Confirm the tier:

```
spin route kb-concept
```

Pass each worker: `FEATURE`, `CONCEPT` (the new slug), `SCHEMA_PATH`.

Each worker writes `concept-<slug>.md` and `.handoffs/kb-concept-<slug>.json`.
The worker does NOT call `spin complete`.

## 5. Mark the concepts wave complete

After all `--replace` and `--add` workers have finished writing their files,
mark the `concepts` artifact complete once:

```
spin complete concepts
```

The `concepts` artifact has no `handoff:` field — do NOT pass `--handoff`.
Exit `0` → recorded. If exit `1`, read the error; this is a usage problem
(e.g., the artifact was not ready), not a handoff validation failure.

> If neither `--replace` nor `--add` was specified (only `--mark-stale` or
> `--audit`), skip this step — no concept wave was re-driven.

## 6. Re-assemble quick-reference and index

After any concept authoring (add or replace), re-drive the assembly artifacts
so they reflect the updated concept set. Dispatch two workers — one per
assembly artifact — **in a single Task message**:

- `quick-reference` worker: re-assembles `.spindle/features/<domain>/quick-reference.md`
  from the current concept pages and sidecars. Model hint: `haiku` (`spin route
  format-convert`). Overwrites the existing file.
- `index` worker: re-assembles `.spindle/features/<domain>/index.md`. Model
  hint: `haiku` (`spin route section-scan`). Overwrites the existing file.

Neither declares a `handoff:` field. Validate + complete each:

```
spin validate quick-reference
spin complete quick-reference
spin validate index
spin complete index
```

> If the update was `--mark-stale` or `--audit` only (no concept pages changed),
> skip re-assembly — the existing assembly files remain valid.

## 7. Final gates

Run both KB gates regardless of what changed. A partial repair can leave coverage
gaps.

```
spin gate G_KB_STRUCTURE
```

```
spin gate G_KB_COVERAGE
```

For each: exit `0` → pass. Exit `1` → STOP, surface `{gate,passed,reasons,unmet}`
verbatim. Do not declare the update done until both gates pass.

When both gates pass, surface the run ledger:

```
spin trace
spin budget --max-tokens 200000
```

Report:
- Domain and updated concept count.
- Which concepts were added, replaced, or marked stale.
- Any concept flagged `needs_decoding` (including newly stale ones).
- `spin budget` outcome (advisory — never blocks).

## Honesty note on `kb_domains` in agent frontmatter

Some agents in `plugin/agents/` declare a `kb_domains` field in YAML frontmatter
(e.g., `kb_domains: [spindle-harness, data-quality]`). This is a declaration of
intent — it is NOT enforced by `src/`. `AgentFrontmatter` (src/core/validation/
frontmatter.ts) does not parse `kb_domains`; `G_ROUTER_COVERAGE` checks only
name-bijection. Whether the model running inside the agent actually reads the
declared KB files is model-trusted behavior, not gate-enforced. This command
does not add or remove `kb_domains` bindings — that is an agent-authoring
responsibility, documented so callers know the guarantee boundary.

## Invariants

- Never mark an artifact complete by hand — always `spin complete <id>`.
- The `manifest.json` concept list is append-only for `--add` and preserved for
  `--replace`. A slug is NEVER removed from the manifest by this command.
  (To retire a concept, use `--mark-stale`; to permanently remove it, edit the
  manifest by hand and re-run `/create-kb --audit` to confirm gate state.)
- Sidecar files are always named `kb-concept-<slug>.json` — never `concepts.json`
  or any artifact-id-based name.
- Workers do NOT call `spin complete`. The orchestrator calls it once per wave.
- Never advance past a gate that exits `1`.
- Concept workers obey E-1: flag `needs_decoding`, never fabricate a meaning.
- `--mark-stale` is non-destructive: it annotates, never deletes.
- Only the commands, flags, gates, and handoff ids above exist — do not invent others.
