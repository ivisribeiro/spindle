---
name: gen-router
description: Parse every agent frontmatter and assemble the agent-router routing.json, then assert agent->routing bijection via G_ROUTER_COVERAGE. Replaces the legacy regex Python router that silently skipped malformed files.
---

Generate the agent-router routing table from source-of-truth agent frontmatter
and validate it with a deterministic gate that fails closed on any malformed,
missing, or duplicated agent — no silent skips.

`/gen-router` is a **one-shot** command: it does not `spin init` a run, so there
is no run-state, no `spin next/complete/retry`, and no graph artifact. The single
deterministic check is `spin gate G_ROUTER_COVERAGE`, which both parses every
agent's frontmatter (fail-closed) and asserts the bijection. The gate is the
validator — the command's job is only to assemble `routing.json` and branch on
the gate's exit code.

## 1 — Assemble routing.json

Dispatch one worker on the `router-assemble` task kind (haiku — mechanical) to
read every agent file under `plugin/agents/` (skip `README.md` and `_`-prefixed
files), extract the `name` from each frontmatter, and write the routing table.

```bash
spin route router-assemble
```

`routing.json` is a flat list of agent **names** (this is the exact shape
`G_ROUTER_COVERAGE` validates):

```json
{ "agents": ["arch-worker", "security-worker", "challenger", "..."] }
```

Write it to `plugin/skills/agent-router/routing.json`. Do not invent entries and
do not drop a file because its frontmatter looks odd — list every agent; the gate
will report the malformed ones precisely.

## 2 — Assert the bijection with G_ROUTER_COVERAGE

```bash
spin gate G_ROUTER_COVERAGE --agents plugin/agents --routing plugin/skills/agent-router/routing.json
```

The gate parses each agent's frontmatter (fail-closed: a file with no parseable
`name` is an error, never a skip) and asserts a bijection: every agent appears in
`routing.json` exactly once, none is missing, and none is unknown.

| Exit | Meaning | Action |
|------|---------|--------|
| 0 | Bijection holds — every agent exactly once, no invalid frontmatter, no silent skips | Report the agent count + the routing.json path. Done. |
| 1 | Blocked — `{gate, passed, reasons, unmet}` printed by spin. `unmet` entries are tagged `missing:<name>`, `duplicate:<name>`, `extra:<name>`, or the malformed file path | Surface `reasons` + `unmet`. Fix the offending agent frontmatter or the routing list, then re-run. **Stop** — do not ship a partial router. |
| 2 / 3 | Usage / internal error | Surface and stop. |

Never assemble a partial routing table to make the gate pass, and never invent
`spin` flags, gate ids, or handoff schemas beyond `route` and
`gate G_ROUTER_COVERAGE`.
