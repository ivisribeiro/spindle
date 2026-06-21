---
name: bounded-loop
description: Bound a build/retry loop with a deterministic counter that lives in the CLI ledger, not in prose. Use whenever a worker handoff fails `spin complete` and you need to re-dispatch, or whenever you would otherwise write "retry up to N times" / "max 3 attempts" into a command. The ceiling is `config.build_retry_cap` enforced by `spin retry <id>`; the loop body lives in the slash command and fans out workers via Task. Corrects the fake-dispatch anti-pattern (no `claude -p`, no inference endpoints).
---

# Bounded loop

A retry loop is bounded when **the counter lives in `run.json` and the ceiling
is enforced by `spin`** — not when a command says "try up to 3 times". The model
counting in its own head is not a bound; it is a suggestion. The bound is
`spin retry <id> --inc | --ok` checked against `config.build_retry_cap`.

## The invariant this skill protects

`spin` (the CLI) NEVER calls a model. The loop *body* runs in the slash command
(the only place a model runs) and fans out workers via the **Task** tool. Every
ordering / counter / ceiling decision is a call to `spin`, and control flow
branches strictly on its **exit code**.

Exit-code ABI: `0` = pass · `1` = gate blocked / handoff invalid / ceiling hit ·
`2` = usage error · `3` = internal error.

Invoke the CLI as `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>`
(shorthand below: `spin <args>`).

## Anti-pattern this corrects: ECC fake-dispatch

The ECC `autonomous-agent-harness` pattern told the command to "dispatch the
build agent" by shelling out to an inference endpoint (`claude -p ...`) and to
"retry up to 3 times" in prose. Both are wrong here:

| Fake-dispatch (do NOT do) | This harness (do) |
|---|---|
| Command runs `claude -p` / hits an inference endpoint | Command fans out a worker via the **Task** tool on the routed model |
| "retry up to 3 times" written in the command prose | Counter in `run.json`, ceiling = `config.build_retry_cap`, enforced by `spin retry` |
| Model decides when it has "tried enough" | `spin retry <id> --ok` exits `1` at the ceiling; the model obeys the exit code |
| `spin` asked to run/choose a model | `spin` only validates, counts, gates — never calls a model |

If you ever find yourself writing `claude -p`, an HTTP call to a model, or a
hard-coded retry number, stop: the counter belongs in the CLI.

## The loop

Each ready artifact (from `spin next`) is attempted, validated by
`spin complete --handoff`, and re-attempted on exit `1` until the handoff
validates or `spin retry --ok` reports the ceiling. Pseudocode for one artifact:

```text
# 1. learn the ready artifact + its model hint
spin next                     # -> { ready:[{id,model,parallel_group}], ... }

# 2. resolve the tier for the work kind (or use the artifact's model hint)
spin route code-build         # -> { tier, model, reason }

loop:
  # 3. dispatch the worker on the routed model via the Task tool.
  #     The worker writes its markdown artifact AND a JSON handoff sidecar
  #     (.spindle/features/<feature>/.handoffs/<id>.json, schema id: build-task).

  # 4. validate the handoff, then mark complete — never mark complete by hand
  spin complete <id> --handoff <sidecar>
  if exit 0:  break          # handoff valid -> artifact done, leave the loop

  # exit 1 -> handoff invalid. Charge one attempt against the ceiling:
  spin retry <id> --ok
  if exit 1:  STOP           # ceiling (config.build_retry_cap) hit -> surface + halt
  spin retry <id> --inc       # record the attempt in run.json
  goto loop                  # re-dispatch a fresh worker via Task
```

Notes:
- `--ok` is the **gate read**: it exits `1` *at* the ceiling and `0` while
  budget remains. Check it BEFORE `--inc` so the attempt you are about to start
  is still within budget.
- `--inc` is the **write**: it advances `retries{<id>}` in the ledger.
- The number lives in `config.build_retry_cap` in the active schema, not in
  this file. Changing the cap is a schema edit, never a prose edit.
- Re-dispatch means a fresh **Task** worker on the routed model — not a manual
  fix and not a re-run of `spin`.

## Inspecting the counter

```bash
spin state            # the run.json ledger: completed[], retries{}, gates{}
```

`retries{<id>}` is the live attempt count for the artifact; `config.build_retry_cap`
is its ceiling. These are the source of truth — never assert "we've retried N
times" from memory.

## Where the loop sits in the phase gate

The bounded loop produces the per-artifact handoffs that `G_BUILD` then audits.
`G_BUILD` (every manifest file exists on disk + criteria-diff empty +
BUILD_REPORT exists) **replaces the old prose "max 3 retries + checkbox"** — the
loop guarantees forward progress, the gate guarantees the result:

```bash
spin gate G_BUILD     # exit 0 -> proceed toward /ship; exit 1 -> STOP, surface {reasons,unmet}
```

If `spin retry <id> --ok` hits the ceiling, STOP and surface the failing artifact
id and its `retries{}` count plus `config.build_retry_cap`. Do not advance the
phase, do not run `G_BUILD` as if it passed, and do not hand-edit `run.json`
(it is CLI-written only).

## Checklist before you ship a command that loops

- [ ] The loop body dispatches workers via the **Task** tool, never `claude -p`
      or an inference endpoint.
- [ ] Every re-attempt is gated by `spin retry <id> --ok` (read) then recorded by
      `spin retry <id> --inc` (write).
- [ ] No hard-coded retry number anywhere in prose; the ceiling is
      `config.build_retry_cap`.
- [ ] Completion is only ever `spin complete <id> --handoff <sidecar>`, branching
      on exit code — never a hand-marked completion.
- [ ] On ceiling hit, control flow STOPs and surfaces the artifact id +
      `retries{}` from `spin state`; the phase gate (`spin gate G_BUILD`) is not
      advanced past.
