# Spindle Knowledge Base

> Structured knowledge domains that workers can consult during task execution.
> Creation and updates are gated. Runtime consultation is model-trusted — read the
> honesty section before assuming otherwise.

---

## What the KB system is

The KB stores domain concepts as flat markdown files under `plugin/kb/<domain>/`.
Each domain has:

- `index.md` — overview and navigation hub
- `quick-reference.md` — fast lookup tables
- `concept-<slug>.md` — one concept per file (the gate-enforced unit)
- `manifest.json` — declares the concept slugs the domain covers

The KB generator (`/create-kb`) and updater (`/update-kb`) are harness-native:
they drive the `spin` ledger through a three-wave graph (Wave A manifest → Wave B
parallel concept fan-out → Wave C assembly), gated by `G_KB_STRUCTURE` and
`G_KB_COVERAGE`. Those gates are pure deterministic functions in
`src/core/gates/kb-gates.ts`; they read the filesystem and the run-state, never
conversation memory.

---

## KB-First: a declared, existence-checked binding (not a usage proof)

Agents that use KB domains declare them in their frontmatter:

```yaml
kb_domains:
  - spindle-harness
```

`kb_domains` is parsed by `AgentFrontmatter` in
`src/core/validation/frontmatter.ts` (optional, additive). `G_ROUTER_COVERAGE`
then checks **referential integrity**: every declared `kb_domain` must resolve to
a real `plugin/kb/<domain>/` directory (pass `--kb <dir>` to point elsewhere) — a
dangling or typo'd domain BLOCKS the gate. The check fires only when at least one
agent declares a domain. What it does NOT — and structurally CANNOT — check is
whether the model actually READ the domain at runtime.

**What this means in practice:** declaring `kb_domains` is referential integrity
(a named contract), not proof of consultation. The filing system exists; the
read is model-trusted. Creation and update are deterministically gated; runtime
consultation is not. Do not claim "code-enforced KB-First" — that would be a
false assertion. The honest framing: the KB gives agents a stable, versioned
material to cite, and the gates ensure that material is coherent.

---

## E-1 honesty rule

Every concept worker is bound by rule E-1, enforced by the `KbConceptHandoff`
schema (`kb-concept` handoff id, `src/core/handoff/schemas.ts`):

- If a value map, enum, or encoding is present in source material, reproduce it
  exactly.
- If it is inferred, partially observed, or absent, do NOT write it as fact.
  Instead write "Encoding opaque — see source" and set `needs_decoding: true`
  in the handoff sidecar.
- `G_KB_COVERAGE` surfaces any concept flagged `needs_decoding` so it is visible
  to the steward, not buried.

E-1 applies to every concept in every domain. It is the KB's core honesty
contract.

---

## File layout

```
plugin/kb/
  README.md                    this file
  <domain>/
    manifest.json              { "concepts": [{ "slug": "..." }] }
    index.md                   required by G_KB_STRUCTURE
    quick-reference.md         required by G_KB_STRUCTURE
    concept-<slug>.md          one per slug in manifest (G_KB_COVERAGE checks each)
```

The flat `concept-<slug>.md` layout (not a `concepts/` subdirectory) is what
`G_KB_STRUCTURE` scans for (`f.startsWith('concept-') && f.endsWith('.md')`).
Any domain that deviates from this layout will fail the gate.

---

## Creating or updating a KB domain

Use the slash commands — do not hand-author without running the gates.

```
/create-kb <domain>           scaffold + author a new domain through the spin kb graph
/create-kb <domain> --audit   re-run G_KB_STRUCTURE + G_KB_COVERAGE without re-authoring
/update-kb <domain>           refresh/extend an existing domain (re-author only changed slugs)
```

The `kb` schema graph has exactly four artifact ids: `manifest`, `concepts`,
`quick-reference`, `index`. Workers are dispatched via the Task tool at the tier
from `spin route kb-concept` (sonnet, downgradable to haiku under `--budget low`
when the gate backstops). Never pass `--handoff` to `spin complete` for these
ids — the kb graph declares no `handoff:` field on them; per-slug `kb-concept`
sidecars are enforced at gate time by `G_KB_COVERAGE`, not at completion time.

---

## Domains

Domains in this directory are authored through `/create-kb` and satisfy
`G_KB_STRUCTURE` + `G_KB_COVERAGE`. The directory listing IS the registry — do not
hand-type file counts or dates in this README (they go stale and the guard will
not catch prose drift). Every `kb_domain` declared on an agent must match a
directory here, or `G_ROUTER_COVERAGE` blocks.

The seed domain `spindle-harness` covers the hard seam, gate catalog, handoff
ABI, exit-code ABI, model routing, and the run-ledger. It is the domain workers
should consult when writing commands, agents, or gates for this project.
