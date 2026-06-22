---
name: create-kb
description: Build a complete, governed knowledge base for a domain by driving the kb graph through the spin harness — scaffold, manifest the concept set, fan out one concept worker per slug in parallel, then assemble quick-reference + index, gated by G_KB_STRUCTURE and G_KB_COVERAGE.
---

# /create-kb

Author a full KB domain by driving the `spin` kb graph, not by blind delegation.
`spin` owns ordering, validation, gates, and the ledger; this command runs the
loop and fans workers out via Task. The CLI never calls a model — every
ordering/validation/gate/state decision comes from a `spin` exit code.

Shorthand used below: `spin <args>` ≡ `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>`.
Exit-code ABI: `0` pass · `1` gate blocked / handoff invalid · `2` usage · `3` internal.

## Inputs

- `<domain>` — the KB domain slug (required). Used as the feature.
- `--audit` — audit mode: re-run the structure + coverage gates against the
  existing KB on disk and report, instead of authoring. See **Audit mode**.

## 0. Scaffold (skip in `--audit`)

Initialize the kb schema and run ledger for this domain:

```
spin init --schema kb --feature <domain>
```

This copies the editable kb schema into `.spindle/schema.yaml` and creates
`.spindle/run.json`. Confirm the active graph before driving it:

```
spin schema show
```

The schema declares four artifact ids: `manifest`, `concepts`, `quick-reference`,
`index`. None declares a `handoff:` field — keep this in mind; see the
**Sidecar naming invariant** below.

## 1. Drive the kb graph with `spin next`

Loop until the graph reports complete. On every iteration:

```
spin next
```

It returns `{ ready:[{id,model,parallel_group}], blocked:{}, complete:bool }`.

- `complete: true` → the graph is done; go to **2. Gates**.
- Otherwise dispatch every artifact in `ready`. Artifacts that share a
  `parallel_group` MUST be dispatched in a SINGLE message (true parallel fan-out).
- For each ready artifact, take its model from the `model` hint (or confirm with
  `spin route <kind>`), then dispatch one worker via the Task tool on that tier.
- Each worker writes its markdown artifact under `.spindle/features/<domain>/`.
  Concept workers also write a `kb-concept` JSON sidecar under
  `.spindle/features/<domain>/.handoffs/` — see **Sidecar naming invariant**.
- The four artifact ids (`manifest`, `concepts`, `quick-reference`, `index`) declare
  NO `handoff:` field. Mark each complete without `--handoff`:

```
spin complete <id>
```

  Exit `0` → recorded. Re-dispatch a worker if its output is incomplete,
  bounded by the per-artifact retry counter:

```
spin retry <id> --inc      # before each re-dispatch
spin retry <id> --ok       # exit 1 at ceiling → stop and surface the failure
```

Then call `spin next` again. The graph hands you the waves in this order:

### Wave A — manifest (single worker, sonnet)

The first ready artifact is the concept manifest, graph id `manifest`. Dispatch
one worker (its hint is `sonnet`; confirm with `spin route kb-concept`) to
enumerate the domain and write `manifest.json`:

```json
{ "concepts": [ { "slug": "..." }, { "slug": "..." } ] }
```

The `manifest` artifact has no `handoff:` and no `validate:` spec, so
`spin validate manifest` only confirms the file exists — it does NOT check the
`{ concepts: [{ slug }] }` shape, and `spin complete manifest` does NOT run
G_HANDOFF. The manifest's structure is enforced later by G_KB_STRUCTURE /
G_KB_COVERAGE. Mark it complete:

```
spin complete manifest
```

The slugs in `manifest.json` are what the concept wave fans out over.
Cap the concept set at 5–7 slugs per domain to keep token spend proportional.

### Wave B — concepts (PARALLEL fan-out, sonnet)

After the manifest completes, `spin next` releases ONE artifact: graph id
`concepts`, with `parallel_group: concepts`. There is no per-slug `concept-<slug>`
graph id — the graph models the whole concept wave as the single `concepts`
artifact. Drive that one id.

Fan the authoring out yourself: read the slugs from `manifest.json` and dispatch
one `kb-concept-worker` per slug **in a single message** (true parallel). Confirm
the tier:

```
spin route kb-concept
```

Pass each worker:
- `FEATURE` — the domain slug
- `CONCEPT` — the specific slug it must author
- `SCHEMA_PATH` — `.spindle/schema.yaml`

Each per-slug worker writes two files (and ONLY these two):

1. `concept-<slug>.md` — the concept page.
2. `.handoffs/kb-concept-<slug>.json` — the handoff sidecar (see invariant below).

The worker does NOT call `spin complete`. That is the orchestrator's job.

Once every per-slug worker has written its page and sidecar, mark the single
wave artifact complete (no `--handoff` — the `concepts` artifact has none):

```
spin complete concepts
```

If a worker's output is incomplete, re-dispatch it before calling `spin complete`:

```
spin retry concepts --inc      # before each re-dispatch
spin retry concepts --ok       # exit 1 at ceiling → stop and surface the failure
```

#### Sidecar naming invariant

`G_KB_COVERAGE` looks for sidecars named exactly `kb-concept-<slug>.json` in
`.spindle/features/<domain>/.handoffs/`. Workers MUST write to that path.
Do NOT use the artifact id (`concepts`) as the sidecar filename — that is
the wrong path and the gate will report coverage failures for every slug.

Correct: `.handoffs/kb-concept-incremental-strategy.json`
Wrong: `.handoffs/concepts.json`

### Wave C — quick-reference + index (haiku)

Once the `concepts` wave is complete, `spin next` releases the quick-reference and
the index. These are mechanical assembly over the completed concept pages and
their `kb-concept` sidecars. Confirm the tier:

```
spin route format-convert    # quick-reference
spin route section-scan      # index
```

Both hint `haiku`. Dispatch one worker per artifact **in a single message**
(they share no explicit `parallel_group` in the schema, but have no dependency
on each other, so fan out together). Neither declares a `handoff:` field —
do not pass `--handoff`. Validate + complete each:

```
spin validate quick-reference
spin complete quick-reference
spin validate index
spin complete index
```

Keep looping `spin next` until `complete: true`.

## 2. Gates

With the graph complete, run the two KB gates. Branch strictly on exit code.

```
spin gate G_KB_STRUCTURE
```

Verifies the KB's structural shape: `manifest.json`, `index.md`, `quick-reference.md`
present, and at least one `concept-*.md` file.

```
spin gate G_KB_COVERAGE
```

Verifies every manifest slug is covered by a `concept-<slug>.md` page with a
valid `kb-concept-<slug>.json` handoff sidecar containing at least the configured
minimum number of test cases. Also surfaces any concept flagged `needs_decoding`.

For each gate: exit `0` → pass. Exit `1` → STOP, surface the `{gate,passed,reasons,unmet}`
payload, and do NOT declare the KB done. Fix the unmet items (re-dispatch the
named concept/assembly workers via the loop above), then re-run the gate.

## 3. Surface the run ledger

After both gates pass, surface usage so the ledger is fed and visible:

```
spin trace
spin budget --max-tokens 200000
```

`spin budget` is advisory (always exits `0`) — it flags over-budget but never
blocks. For a 5–7 concept domain on sonnet, expect ~40–80k tokens total.

Report the domain, concept count, artifacts under `.spindle/features/<domain>/`,
and any concept flagged `needs_decoding` (those are decoding debt — not blocking,
but must be surfaced so the user knows what the KB cannot resolve without more
source material).

## Audit mode (`/create-kb --audit`)

Do NOT re-init or re-author. Inspect the existing run and re-run the gates:

```
spin state
spin gate G_KB_STRUCTURE
spin gate G_KB_COVERAGE
```

Report each gate's exit code and, on exit `1`, its `{reasons,unmet}` so the user
sees exactly which slugs/sections are missing or stale. Re-run `spin validate <id>`
on any artifact a gate flags to localize the defect.

## Invariants

- Never mark an artifact complete by hand — always `spin complete <id>`.
- The kb graph has exactly four artifact ids: `manifest`, `concepts`,
  `quick-reference`, `index`. None declares a `handoff:` field, so NEVER pass
  `--handoff` to `spin complete` for any of these ids.
- Per-slug sidecars are named `kb-concept-<slug>.json`, not `<artifact-id>.json`.
  Workers write them; the orchestrator does NOT pass them to `spin complete`.
  They are validated by G_KB_COVERAGE at gate time.
- Workers write ONLY their concept page and sidecar. The orchestrator calls
  `spin complete concepts` once all workers have finished.
- Never advance past a gate that exits `1`.
- Concept workers obey E-1: flag `needs_decoding`, never fabricate a meaning.
- Cap concept sets at 5–7 per domain; `spin budget` advisory at 200k tokens.
- Only the commands, flags, gates, and handoff ids above exist — do not invent others.
