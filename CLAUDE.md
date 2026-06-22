# CLAUDE.md — spindle contributor doctrine

This file governs anyone (human or model) who edits this repo. Read it before
touching code. If a chat instruction conflicts with the invariant below, **stop
and ask** — do not adapt silently.

`spindle` is a Claude Code plugin. It has two layers and exactly one
seam between them. Keeping that seam clean is the whole job.

---

## 0. The invariant (never violate it)

**`spin` — the CLI in `src/` (shipped as `dist/cli/index.js`) — NEVER calls a
model.** It is a deterministic state machine and gatekeeper: ordering,
validation, gates, routing, the ledger. Given the same `.spindle/` on disk it
returns the same answer and the same exit code, every time, with no network and
no inference.

The **only** place a model runs is a slash command (`commands/*.md`). A command
calls `spin` for every ordering / validation / gate / state / routing decision,
branches **strictly on the exit code**, and fans out worker subagents via the
Task tool. A worker authors an artifact; it never decides control flow.

This invariant is not a guideline — it is enforced by a guard test (see §6). A
change that makes `spin` import an SDK, hit an endpoint, read an API key, or
otherwise become model-aware will fail that test and must not merge. If you
think you need a model inside `spin`, you have mislocated the work: it belongs in
a command or a worker, on the model side of the seam.

Corollary anti-patterns — never do these:
- Telling Claude to "run the agents from node" or call an inference endpoint
  directly. Dispatch is the Task tool, from a command. That is the only
  dispatch path.
- Marking an artifact complete by hand, or having a worker advance a phase.
  Only `spin complete` mutates the ledger; only a passing `spin gate` advances a
  phase.
- Inventing an `spin` subcommand, flag, gate id, handoff id, or route kind.
  The surface in §3–§5 is the whole surface.

---

## 1. The hard seam

```
 model side (commands/, plugin worker agents)   |   deterministic side (src/ -> dist/)
 -------------------------------------------------+--------------------------------------
 commands/*.md   reason, dispatch Task workers   |   spin next/order/state    ordering + ledger
 worker agents   author .md artifact + .json     |   spin complete/validate   schema + structure
                 handoff sidecar                 |   spin gate/diff-criteria  phase gates
                                                 |   spin route               model routing
                 ----- the ONLY crossing is the spin CLI process boundary -----
```

Everything crosses the seam as a child process invocation and an **exit code**.
A command spawns `spin`, reads stdout (JSON) for detail and the exit code for the
decision. There is no shared memory, no callback, no model handle passed across.
That asymmetry is the design: the side that can be wrong (the model) is fenced by
the side that cannot (the CLI).

Invoke the CLI as:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>
```

Throughout this doc and the commands, `spin <args>` is shorthand for exactly that.

---

## 2. Exit-code ABI

Every `spin` subcommand obeys this contract. Commands branch on it; never parse
prose to infer success.

| Code | Meaning | Command must… |
|---|---|---|
| `0` | pass | proceed |
| `1` | gate blocked / handoff invalid | STOP this phase; surface `{reasons,unmet}`; retry or halt — never advance |
| `2` | usage error (bad args/flags) | fix the invocation; this is a bug in the command, not a gate |
| `3` | internal error | abort; do not retry blindly |

`1` is a *domain* outcome (the gate did its job). `2` and `3` are *bugs*. Keep
that distinction sharp when you add a subcommand: a blocked gate is `1`, a
malformed call is `2`, an unexpected crash is `3`. Tests assert on exit code, so
returning the wrong one is a breaking change.

---

## 3. Repo layout

```
src/                  the spin spine — deterministic, model-free (the INVARIANT zone)
  cli/                arg parsing + subcommand dispatch -> index.js entrypoint
  core/               the engine: build order (Kahn), gate evaluation, ledger,
                      criteria diff, routing table. Pure functions over .spindle/ state.
schemas/              JSON Schemas for the handoff sidecars (define, design,
                      build-task, build-report, finding, claim, migration-plan,
                      claudemd-section, kb-concept) + the editable workflow schemas
plugin/               the model-facing layer that ships in the plugin
  commands/           slash commands (.md) — the only place a model runs
  agents/             worker subagents (.md) dispatched via Task
dist/                 compiled CLI (node dist/cli/index.js). BUILD OUTPUT — never hand-edit
.spindle/                 per-project runtime state (see §8). CLI-written; not a source dir
```

`src/core` is the spine: ordering, gates, ledger, routing live here as pure
functions over `.spindle/` state. `src/cli` is a thin adapter — parse args, call
core, print JSON, set the exit code. `schemas/` is the contract the two sides
agree on. `plugin/` is everything the model touches. The seam in §1 is the line
between `src/`+`schemas/` and `plugin/`.

---

## 4. spin command surface (the whole surface — do not extend by invention)

| Command | Returns / effect |
|---|---|
| `spin init --schema <sdd\|kb> --feature <slug>` | scaffold `.spindle/`, copy the editable schema, create `run.json` |
| `spin next` | `{ ready:[{id,model,parallel_group}], blocked:{}, complete:bool }` |
| `spin order` | full Kahn build order |
| `spin trace` | the run-ledger timeline (`events[]`) + a tier/token summary. Pure read, exit 0 — a report, not a gate |
| `spin eval [--corpus d] [--strict]` | replay the eval corpus through the REAL gates; exit 1 on a verdict regression (`--strict` also requires every gate to have a pass+block case) |
| `spin budget [--max-tokens n]` | reconcile model-reported token spend per tier vs an optional ceiling. Advisory — always exit 0 (accounting, not enforcement) |
| `spin fanout-check` | assert no `parallel_group` is partially complete (a dropped fan-out worker); exit 0 all-consistent / 1 partial. Run before a phase gate |
| `spin state` | the `run.json` ledger (`completed[]`, `retries{}`, `gates{}`) |
| `spin complete <id> [--handoff f.json]` | validate the handoff against the artifact's schema, THEN mark complete (exit 1 if invalid) |
| `spin approve [--by <name>]` | record human sign-off (required by `G_SHIP`). REFUSES unless stdin is an interactive TTY — an automated agent cannot approve. No bypass flag |
| `spin validate <id\|path>` | structural checks (md sections / manifest table / criteria IDs); exit 0/1 |
| `spin gate <gateId> [--agents d] [--routing f] [--kb d] [--findings f]` | run a named gate; exit 0 pass / 1 BLOCK with `{gate,passed,reasons,unmet}`. `--kb` (default `plugin/kb`) backs G_ROUTER_COVERAGE's kb_domains referential check |
| `spin diff-criteria --define f --build f` | set-diff DEFINE criteria vs BUILD passed -> `unmet[]` |
| `spin handoff-check <schemaId> <file.json>` | standalone handoff validation |
| `spin retry <id> --inc \| --ok` | retry counter vs `config.build_retry_cap`; `--ok` exits 1 at ceiling |
| `spin route <taskKind> [--budget std\|low]` | `{ tier, model, reason }` |
| `spin schema show \| validate` | inspect / validate the active editable schema |

---

## 5. Gates, handoffs, and route kinds (the closed sets)

**Gate ids** (`spin gate <id>`):
`G_DEFINE` (before /design), `G_DESIGN` (before /build), `G_BUILD` (before
/ship — every manifest file exists on disk + criteria-diff empty + BUILD_REPORT
exists), `G_SHIP` (define.criteria minus build.passed is empty AND a human approval is
recorded via `spin approve` — the seam applied to sign-off: a model cannot approve), `G_KB_STRUCTURE`,
`G_KB_COVERAGE` (every manifest concept authored + enough test cases; manifest shape
is Zod-validated; E-1: a `needs_decoding` concept must carry a non-empty
`decoding_note`), `G_ROUTER_COVERAGE` (agent→routing bijection, no silent skips, PLUS
kb_domains referential integrity — every declared domain must resolve to a
`--kb`/`plugin/kb` dir; existence, NOT usage proof),
`G_REVIEW_BLOCK` (surviving CRITICAL findings > 0 ⇒ block; shared by /review and
/migrate), `G_HANDOFF` (enforced inside `spin complete --handoff`).

**Handoff schema ids** (the `handoff:` field / `spin complete --handoff` /
`spin handoff-check`):
`define`, `design`, `build-task`, `build-report`, `finding`, `claim`,
`migration-plan`, `claudemd-section`, `kb-concept` (carries optional `decoding_note`
for the E-1 honesty rule), `audit`.

**Route task-kinds** (`spin route <kind>`), by tier:
- **HAIKU** (mechanical, gate-backstopped): `file-read`, `structure-extract`,
  `frontmatter-parse`, `template-fill`, `format-convert`, `claim-extract`,
  `ship-prose`, `section-scan`, `router-assemble`.
- **SONNET** (analysis / authoring): `spec-authoring`, `design-synthesis`,
  `code-build`, `kb-concept`, `finding-analysis`, `claim-verify`,
  `migration-plan`, `merge`.
- **OPUS** (deepest + adversarial): `architect`, `define-intent`,
  `design-intent`, `adversary`, `review-judge`, `equivalence-break`.

**Routing doctrine.** Default to the cheapest tier that *verifiably* does the
task. Two hard rules: (a) the verifier/adversary outranks-or-equals the generator
on any CRITICAL gate — never let a cheaper tier be the final judge of a CRITICAL
finding; (b) `--budget low` may downgrade a tier ONLY where a deterministic gate
backstops the output. Critical kinds (`adversary`, `architect`, `review-judge`,
`*-intent`) never downgrade.

---

## 6. How to add things

The seam dictates *where* each kind of change lands. Pick the layer first.

### Add a gate
1. Implement the predicate as a pure function in `src/core` over `.spindle/` state.
   It returns a verdict object — on block, `{gate, passed:false, reasons[], unmet[]}`.
2. Register its id in the gate dispatch so `spin gate <NEW_ID>` reaches it. A
   block is exit `1`; a malformed call is exit `2`.
3. Add a test (§7) covering both a passing and a blocking fixture, asserting on
   the exit code and on `reasons`/`unmet`.
4. Wire it into the relevant command's phase step (§ harness protocol) so the
   command STOPS on exit 1.
5. If the gate is `G_REVIEW_BLOCK`-shaped (CRITICAL findings), confirm the
   verifier tier outranks-or-equals the generator (§5 rule a).

Never add a gate by having a worker "check" something — gates are deterministic
and live in `src/core`, not in a prompt.

### Add a handoff schema
1. Add the JSON Schema to `schemas/` and register its id in the closed set the
   CLI knows (§5). The id is what workers put in the `handoff:` field and what
   `spin complete --handoff` / `spin handoff-check` validate against.
2. Make the producing worker write a JSON sidecar that matches it, alongside its
   `.md` artifact.
3. The command validates via `spin complete <id> --handoff <sidecar>` — exit 1
   means the handoff is invalid; re-dispatch (bounded by `spin retry`).
4. Add a fixture pair (valid + invalid) and assert `handoff-check` returns 0 / 1.

A new artifact type that does not carry an existing handoff id needs its schema
added here first — there is no "untyped" handoff.

### Add a command (slash command)
1. Create `plugin/commands/<name>.md` with YAML frontmatter (`name`,
   `description`) and concise imperative markdown.
2. The command body must follow the harness protocol below — call `spin` for
   every decision and branch on exit code. Real `spin` invocations go in fenced
   blocks; no invented flags.
3. It dispatches workers via Task on the tier from `spin route <kind>` (or the
   artifact's model hint), never by calling a model directly.

### Add a worker agent
1. Create `plugin/agents/<name>.md` with valid frontmatter: `name`,
   `description`, plus `tools` and `model`. Invalid or missing `name`/
   `description` fails `G_ROUTER_COVERAGE` (it validates the roster).
2. The worker authors exactly one `.md` artifact **and** one `.json` handoff
   sidecar matching a schema id from §5. It does not run `spin`, does not touch
   the ledger, does not advance phases.
3. Every agent must be reachable from routing — `G_ROUTER_COVERAGE` enforces an
   agent→routing bijection with no silent skips. A new agent with no route is a
   gate failure, not a stray file.

### Add a route task-kind
A route kind is part of the closed set in §5 and the routing table in
`src/core`. Adding one means editing that table, classifying its tier under the
routing doctrine, and adding a `spin route <kind>` test. Do not reference a
task-kind from a command that the routing table does not know.

---

## 7. The harness protocol every workflow command obeys

This is the whole control loop. Encode it in every workflow command; never
shortcut a step.

1. `spin next` — learn the ready artifact(s) and each one's model hint.
2. For each ready artifact, read `spin route <kind>` (or the model hint) and
   dispatch a worker via Task on that tier. **Independent artifacts in the same
   `parallel_group` fan out in a SINGLE message** (true parallel).
3. The worker writes its `.md` artifact AND its `.json` handoff sidecar.
4. `spin complete <id> --handoff <sidecar>`. Exit 1 ⇒ the handoff is invalid:
   re-dispatch, bounded by `spin retry <id> --inc`, stopping at the `--ok`
   ceiling (exit 1 at ceiling). **Never mark complete by hand.**
5. `spin gate <gateId>` for the phase. Exit 1 ⇒ STOP, surface `{reasons,unmet}`,
   do not advance. Exit 0 ⇒ proceed to the next phase.

Phase chain for the SDD workflow: `G_DEFINE` → `G_DESIGN` → `G_BUILD` →
`G_SHIP`; KB adds `G_KB_STRUCTURE` / `G_KB_COVERAGE`; `/review` and `/migrate`
share `G_REVIEW_BLOCK`. `spin init --schema <sdd|kb> --feature <slug>` bootstraps
a run.

Deterministic decisions in `spin`; authoring in workers; control flow branching
on exit codes. That is the entire mechanism.

---

## 8. .spindle/ on-disk layout (CLI-written only)

```
.spindle/run.json                                  the ledger — CLI-written ONLY
.spindle/schema.yaml                               the active editable workflow
.spindle/features/<feature>/<ARTIFACT>.md          worker-authored artifacts
.spindle/features/<feature>/.handoffs/<id>.json    handoff sidecars
```

A command or worker reads `.spindle/` via `spin state` / `spin next`; only `spin`
mutates `run.json`. Do not hand-edit the ledger — the determinism guarantee
depends on it being machine-owned.

`run.json` also carries an append-only `events[]` ledger — the run's *trajectory*
(`complete` / `gate` / `retry`), distinct from the current-state maps
(`completed[]` / `retries{}` / `gates{}`). It is written only at the existing CLI
mutation points and is a pure superset, so crash-safety and idempotency hold (an
unchanged gate re-run appends nothing). A `complete` event may carry an **opaque,
model-reported `usage`** annotation (`{tier, model?, tokens_in?, tokens_out?}`) that
the worker put on its handoff sidecar — the CLI **records** it, never computes or
prices it (the guard test forbids tokenizers/pricing in `src/`). `spin trace` reads
this ledger; it is accounting, not enforcement.

---

## 9. Build & test

```bash
npm run build          # compile src/ -> dist/ (the spin CLI). Run before testing the plugin.
npm test               # full suite incl. the guard test that spin never calls a model
npm run test:coverage  # suite with coverage
```

The guard test is the executable form of §0 — if a change makes `spin`
model-aware, `npm test` fails. Treat a red guard test as a design error, not a
test to update. Rebuild (`npm run build`) before exercising commands, since they
invoke the compiled `dist/cli/index.js`.

---

## 10. Definition of done (per change)

- [ ] Correct layer: deterministic logic in `src/core`, schemas in `schemas/`,
      model-facing prose in `plugin/`. Nothing model-aware crossed into `src/`.
- [ ] Exit-code ABI honored (§2): block = 1, usage = 2, crash = 3.
- [ ] New gate/handoff/route uses only ids from the closed sets (§5); none
      invented.
- [ ] Commands branch on exit code and follow the harness protocol (§7); no
      hand-completion, no direct model dispatch.
- [ ] New worker agent has valid `name`/`description` frontmatter and a route
      (`G_ROUTER_COVERAGE` green).
- [ ] `npm run build` clean; `npm test` green, **including the model-free guard
      test and the authorship guard**; coverage not regressed (`npm run test:coverage`).

---

## 11. Vocabulary — Spindle's terms (and the upstream nouns to retire)

Spindle is its own product, not a visible fork. Use these terms in code, comments,
docs, commands, and worker prose. The authorship guard (`scripts/guard-no-fork-tells.js`,
run in CI and as a vitest test) **fails the build if an upstream source name leaks into
`plugin/` prose** — provenance lives in `CREDITS.md` and per-file `origin:` frontmatter
stamps, nowhere else.

| Use this | Not this | Meaning |
|---|---|---|
| **the seam** | — | the one boundary where the model side calls the deterministic `spin` CLI and branches on its exit code |
| **artifact graph** | OpenSpec "change" / "proposal" | the Kahn-ordered DAG of phase artifacts a run advances through |
| **handoff sidecar** | — | the typed `.json` a worker writes beside its `.md`, validated by `spin complete --handoff` |
| **run-ledger** | — | `.spindle/run.json`, CLI-written only — the crash-safe record of `completed[]` / `retries{}` / `gates{}` |
| **gate verdict** | — | a gate's `{passed, reasons[], unmet[]}`, surfaced via exit code |
| **worker** | "AgentSpec agent" | a subagent that authors one artifact + one handoff and never decides control flow |
| **orchestration tier** (T0/T1/T2) | — | how much machinery a task warrants: solo / one worker / fan-out + adversary |
| **routed tier** (Haiku/Sonnet/Opus) | — | the model a task-kind runs on, returned by `spin route` |

Naming rule: never write **AgentSpec**, **OpenSpec**, or **ECC** into `plugin/` prose.
Credit upstreams once in `CREDITS.md`; stamp an adapted file with `origin: <source>` in
its frontmatter (the guard allows the literal only on an `origin:` line).
