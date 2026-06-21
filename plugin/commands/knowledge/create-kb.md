---
name: create-kb
description: Build a complete, governed knowledge base for a domain by driving the kb graph through the spin harness — scaffold, manifest the concept set, fan out one concept worker per slug in parallel, then assemble quick-reference + index, gated by G_KB_STRUCTURE and G_KB_COVERAGE.
---

# /create-kb

Author a full KB domain by driving the `spin` kb graph, not by blind delegation.
`spin` owns ordering, validation, gates, and the ledger; this command runs the
loop and fans workers out via Task. The CLI never calls a model — every
ordering/validation/gate/state decision comes from an `spin` exit code.

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
  `.spindle/features/<domain>/.handoffs/` (enforced at gate time by G_KB_COVERAGE,
  not at complete time — see Wave B).
- Mark complete only through the CLI. The kb graph's four artifacts
  (`manifest`, `concepts`, `quick-reference`, `index`) declare no `handoff:`
  field, so `spin complete <id>` records completion without running G_HANDOFF —
  do not pass `--handoff` for these ids:

```
spin complete <id>
```

  Exit `0` → recorded. Re-dispatch a worker if its output is incomplete,
  bounded by the per-artifact retry counter:

```
spin retry <id> --inc      # before each re-dispatch
spin retry <id> --ok       # exit 1 at ceiling -> stop and surface the failure
```

Then call `spin next` again. The graph hands you the waves in this order:

### Wave A — manifest (single worker)

The first ready artifact is the concept manifest, graph id `manifest`. Dispatch
one worker (its hint is `sonnet`; use the `model` from `spin next`) to enumerate
the domain and write `manifest.json`:

```json
{ "concepts": [ { "slug": "..." }, { "slug": "..." } ] }
```

The `manifest` artifact has no `handoff:` and no `validate:` spec, so
`spin validate manifest` only confirms the file exists — it does NOT check the
`{ concepts: [{ slug }] }` shape, and `spin complete manifest` does not run
G_HANDOFF. The manifest's structure is enforced later, at gate time, by
G_KB_STRUCTURE / G_KB_COVERAGE. Mark it complete:

```
spin complete manifest
```

The slugs in `manifest.json` are what the concept wave fans out over.

### Wave B — concepts (PARALLEL fan-out, sonnet)

After the manifest completes, `spin next` releases ONE artifact: graph id
`concepts`, with `parallel_group: concepts`. There is no per-slug `concept-<slug>`
graph id — the graph models the whole concept wave as the single `concepts`
artifact. Drive that one id.

Fan the authoring out yourself: read the slugs from `manifest.json` and dispatch
one worker per slug **in a single message** (true parallel). Concept authoring is
the `kb-concept` task-kind → sonnet; confirm with `spin route kb-concept`.

Each per-slug worker writes:

- `concept-<slug>.md` — the concept page.
- a `kb-concept` handoff sidecar `.handoffs/kb-concept-<slug>.json`:

```json
{
  "concept": "<slug>",
  "summary": "one-paragraph plain-language summary",
  "test_cases": [ "..." ],
  "needs_decoding": false
}
```

Honesty rule (E-1): a worker NEVER invents a meaning. If a code/value is opaque,
it sets `"needs_decoding": true` rather than fabricating a decode.

The `concepts` artifact has no `handoff:` field, so `spin complete concepts` does
NOT run G_HANDOFF on any sidecar. The per-slug `kb-concept` sidecars are written
to `.handoffs/` and are validated later, at gate time, by G_KB_COVERAGE (which
checks every manifest slug has a concept page with a valid `kb-concept` handoff)
— not at complete time. Once every per-slug worker has written its page and
sidecar, mark the single wave artifact complete:

```
spin complete concepts
```

If a worker's output is incomplete, re-dispatch it and bound the wave with the
`concepts` retry budget (there is no per-slug retry counter):

```
spin retry concepts --inc      # before each re-dispatch
spin retry concepts --ok       # exit 1 at ceiling -> stop and surface the failure
```

### Wave C — quick-reference + index (haiku)

Once the `concepts` wave is complete, `spin next` releases the quick-reference and
the index. These are mechanical assembly over the completed concept pages and
their `kb-concept` sidecars → haiku (confirm with `spin route format-convert` /
`spin route section-scan`). Neither artifact declares a `handoff:` field, so do
not pass `--handoff`. Dispatch, then validate (structural section check) +
complete each:

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

Verifies the KB's structural shape (manifest ↔ concept pages, required sections,
quick-reference + index present).

```
spin gate G_KB_COVERAGE
```

Verifies every manifest slug is covered by a concept page with a valid
`kb-concept` handoff (and surfaces any `needs_decoding` debt).

For each: exit `0` → pass. Exit `1` → STOP, surface the `{gate,passed,reasons,unmet}`
payload, and do not declare the KB done. Fix the unmet items (re-dispatch the
named concept/assembly workers via the loop above), then re-run the gate.

When both gates pass, report the domain, the concept count, the artifacts under
`.spindle/features/<domain>/`, and any concept flagged `needs_decoding`.

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
  `quick-reference`, `index`. None declares a `handoff:` field, so never pass
  `--handoff` to `spin complete`, and never invent per-slug `concept-<slug>` ids
  for `complete`/`retry`/`validate` — drive the single `concepts` wave id.
- `kb-concept` sidecars are enforced by G_KB_COVERAGE at gate time, not by `spin complete`.
- Never advance past a gate that exits `1`.
- Concept workers obey E-1: flag `needs_decoding`, never fabricate a meaning.
- Only the commands, flags, gates, and handoff ids above exist — do not invent others.
