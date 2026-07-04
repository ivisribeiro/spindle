---
name: gen-router
description: Parse every agent frontmatter and assemble the agent-router routing.json, then assert agent->routing bijection via G_ROUTER_COVERAGE. Replaces the legacy regex Python router that silently skipped malformed files.
---

Generate the agent-router routing table from source-of-truth agent frontmatter
and validate it with a deterministic gate that fails closed on any malformed,
missing, or duplicated agent — no silent skips.

`/gen-router` is a **one-shot** command: it does not `spin init` a run, so there
is no run-state, no `spin next/complete/retry`, and no graph artifact. The single
deterministic check is `spin gate G_ROUTER_COVERAGE`, which parses every agent's
frontmatter (fail-closed), asserts the bijection, AND semantically validates each
roster entry (description, model, model↔routing agreement, kb_domains). The gate
is the validator — the command's job is only to assemble `routing.json` and branch
on the gate's exit code.

## 1 — Assemble routing.json

Dispatch one worker on the `router-assemble` task kind (haiku — mechanical) to
read every agent file under `plugin/agents/` (skip `README.md` and `_`-prefixed
files), extract each frontmatter's `name`, `model`, and `kb_domains`, and write
the routing table.

```bash
spin route router-assemble
```

`routing.json` is a list of rich **objects** — `{ name, model, kb_domains }` — one
per agent (this is the exact shape `G_ROUTER_COVERAGE` now validates):

```json
{
  "agents": [
    { "name": "arch-worker", "model": "sonnet", "kb_domains": [] },
    { "name": "define-worker", "model": "opus", "kb_domains": ["spindle-harness"] },
    { "name": "ship-worker", "model": "haiku", "kb_domains": ["spindle-harness"] }
  ]
}
```

- `model` is copied **verbatim** from the agent's frontmatter `model` (an agent
  that omits it is `inherit`). It MUST be one of `haiku | sonnet | opus | inherit`.
- `kb_domains` mirrors the agent's declared domains (`[]` when none).

Write it to `plugin/skills/agent-router/routing.json`. Do not invent entries and
do not drop a file because its frontmatter looks odd — list every agent; the gate
will report the malformed ones precisely. The **legacy flat-string** format
(`{ "agents": ["arch-worker", ...] }`) is rejected — regenerate objects.

## 2 — Assert the roster with G_ROUTER_COVERAGE

```bash
spin gate G_ROUTER_COVERAGE --agents plugin/agents --routing plugin/skills/agent-router/routing.json --kb plugin/kb
```

The gate parses each agent's frontmatter (fail-closed) and validates, for every
roster agent:

- **bijection** — appears in `routing.json` exactly once, none missing, none unknown;
- **description present, not degraded** — a name-only / unparseable frontmatter
  (the tolerant fallback) is now a BLOCK naming the file, not a silent shrug;
- **model in the closed set** `haiku | sonnet | opus | inherit`;
- **no model drift** — the routing entry's `model` MUST match the agent
  frontmatter's `model`;
- **kb_domains referential integrity** — every declared domain resolves to a real
  `plugin/kb/<domain>/` dir (existence, not usage proof).

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Roster valid — bijection holds, every frontmatter typed, models validated, no drift, kb_domains resolve | Report the agent count + the routing.json path. Done. |
| 1 | Blocked — `{gate, passed, reasons, unmet}` printed by spin. `unmet` entries are tagged `missing:<name>`, `duplicate:<name>`, `extra:<name>`, `degraded:<name>`, `invalid-model:<name>`, `model-drift:<name>`, `missing-model:<name>`, `legacy-format`, `malformed-entry`, `dangling-kb-domain:<name>:<domain>`, `kb-dir-missing`, or the malformed file path | Surface `reasons` + `unmet`. Fix the offending agent frontmatter or the routing entry, then re-run. **Stop** — do not ship a partial router. |
| 2 / 3 | Usage / internal error | Surface and stop. |

Never assemble a partial routing table to make the gate pass, and never invent
`spin` flags, gate ids, or handoff schemas beyond `route` and
`gate G_ROUTER_COVERAGE`.
