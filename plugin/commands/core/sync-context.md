---
name: sync-context
description: >
  Rewrite CLAUDE.md by fanning out 5 parallel section-scan workers (haiku),
  collecting claudemd-section handoffs, then merging deterministically using
  each section's declared strategy field (preserve | replace | merge).
---

## Purpose

Keep `CLAUDE.md` coherent after deep-work sessions: detect stale sections,
integrate new operational facts, and preserve intentional doctrine — all
without LLM free-merge drift.

---

## Invocation

```
/sync-context [--claudemd <path>] [--budget std|low]
```

Default `--claudemd` is `CLAUDE.md` in the repo root.  
Default `--budget` is `std`.

---

## Step 0 — Route & initialize

```bash
spin route section-scan --budget $BUDGET
# -> { tier: "haiku", model: "...", reason: "..." }
```

Store `SECTION_MODEL` from the response.

Initialize a minimal ledger so `spin retry` has a backing store for the
per-worker re-dispatch counter:

```bash
spin init --schema sdd --feature sync-context
```

(The schema contents are not used; `spin init` creates `.spindle/run.json` which
`spin retry` requires to persist counts.)

---

## Step 1 — Parse CLAUDE.md into sections

Dispatch **1 haiku worker** (Task) to slice `CLAUDE.md` into sections.

**Worker prompt (section-parser):**

> Read the file at `$CLAUDEMD_PATH` in full.
> For every top-level `##` heading, emit a JSON array element with:
> `{ "id": "<slug>", "heading": "<exact heading text>", "body": "<verbatim body>" }`.
> Write the array to `.spindle/sync-context/sections-raw.json`.
> Assign each section an `id` that is the heading lowercased, spaces→hyphens,
> punctuation stripped (e.g. `## 1. Princípios invioláveis` → `principios-inviolaveis`).

Wait for the worker to complete (single task, no gate needed here).

---

## Step 2 — Fan out 5 parallel section-scan workers

Read `.spindle/sync-context/sections-raw.json`.  
Partition the section array into **5 roughly equal slices** (slice 0–4).

Dispatch ALL 5 workers in a **single Task message** (true parallel, same
`parallel_group: "section-scan"`). Each worker receives its slice.

**Per-worker prompt template (repeat 5×, fill `$SLICE_JSON`):**

> You are a section-scan worker. Your input sections (JSON array) are:
>
> `$SLICE_JSON`
>
> For each section, decide:
>
> - `strategy: "preserve"` — doctrine, invariants, anti-patterns, canonical
>   vocabulary, numbered rules that must not drift. Do not alter body.
> - `strategy: "replace"` — purely operational facts that are now stale
>   (e.g. outdated port numbers, removed service names, superseded ADR refs).
>   Provide an updated `content` body.
> - `strategy: "merge"` — sections that need new facts appended or old lines
>   updated but whose structure must remain (e.g. §21 operational notes,
>   §21.8 gotchas, event catalogue, pending questions).
>   Provide the full merged `content` body.
>
> Emit a JSON array of handoff objects.
> Each object MUST match the `claudemd-section` handoff schema:
>
> ```json
> {
>   "handoff": "claudemd-section",
>   "id": "<section-id>",
>   "heading": "<exact heading>",
>   "strategy": "preserve|replace|merge",
>   "content": "<final body — identical to input when strategy=preserve>"
> }
> ```
>
> Write the array to `.spindle/sync-context/handoffs-worker-$WORKER_INDEX.json`.
>
> Rules:
> - When `strategy=preserve`, copy `body` verbatim into `content`. No edits.
> - When `strategy=replace`, write the complete new body in `content`.
> - When `strategy=merge`, write the complete merged body in `content`
>   (integrate new facts; do not delete existing correct lines).
> - Never invent spin commands, gate ids, or handoff schema ids.

Collect all 5 worker output files before proceeding.

---

## Step 3 — Validate handoffs

For each of the 5 handoff files, run:

```bash
spin handoff-check claudemd-section .spindle/sync-context/handoffs-worker-$N.json
```

Exit code 1 means the handoff JSON is malformed or missing required fields.
On failure, gate the re-dispatch on the CLI counter:

```bash
spin retry worker-$N --inc   # increment; exits 0 while under ceiling
spin retry worker-$N --ok    # exits 1 when ceiling is reached
```

If `--inc` exits 0, re-dispatch that worker and re-validate.
If `--ok` exits 1 (ceiling reached), surface `{reasons}` and abort.
The ceiling is `config.build_retry_cap` — do not hardcode a number.

---

## Step 4 — Deterministic merge

This step runs in the orchestrating command, NOT in a worker — no LLM involved.

Algorithm:

1. Load all validated handoff arrays, flatten into a single list keyed by `id`.
2. Load `.spindle/sync-context/sections-raw.json` (original order).
3. For each section in original order:
   - Look up the matching handoff by `id`.
   - Apply strategy:
     - `preserve` → emit `body` from raw (ignore handoff `content` as extra safety).
     - `replace`  → emit handoff `content`.
     - `merge`    → emit handoff `content`.
4. Reassemble with original `##` headings and any preamble/frontmatter that
   appeared before the first `##`.
5. Write result to `CLAUDE.md` (overwrite).

**No LLM touches the final assembly.** The merge is a deterministic ordered
substitution driven solely by `strategy`.

---

## Step 5 — Validate result

```bash
spin validate $CLAUDEMD_PATH
```

Exit 0 → surface a summary of changes (per section: strategy applied + one-line
diff summary).  
Exit 1 → structural check failed; restore original from `.spindle/sync-context/sections-raw.json`
backup and surface `{reasons, unmet}`.

---

## Output

```
sync-context complete
  sections scanned : <N>
  preserve         : <n>
  replace          : <n>
  merge            : <n>
  validation       : PASS
```

---

## Error handling

| Condition | Action |
|---|---|
| Worker handoff invalid (exit 1 from `spin handoff-check`) | `spin retry <worker-id> --inc` (re-dispatch while exit 0); abort when `spin retry <worker-id> --ok` exits 1 (ceiling) |
| `spin validate` exit 1 after write | Restore backup; surface unmet reasons |
| CLAUDE.md not found at `--claudemd` path | Abort immediately with usage error (exit 2) |
| Fewer than 1 section parsed | Abort — file may not use `##` headings |
