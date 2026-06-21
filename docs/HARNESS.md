# spindle — Architecture

> The deterministic spine that makes an LLM workflow *testable*. `spin` is the
> state machine and gatekeeper; the slash commands are the only model-execution
> layer. The seam between them is the whole design.

---

## 1. The one invariant

**`spin` (the CLI) NEVER calls a model.** It is a real TypeScript/Node executable
— esbuild-bundled, vitest-tested, commander-based — that owns every deterministic
decision: dependency ordering, structural validation, named gates, run-state, and
model routing. The slash commands are the only place a model runs. They call `spin`
for every ordering/validation/gate/state decision, branch strictly on its **exit
code**, and fan out worker subagents via the `Task` tool.

There is no `fetch`, no `anthropic`, no `claude -p`, and no dispatch endpoint
anywhere in `src/`. A grep-guard test fails CI if any of those strings appears in
`src/`. This is not a stylistic preference — it is the property that makes the
whole system testable. You can write a vitest assertion that the CLI ordered files
by dependency or blocked on a missing artifact. You cannot write an assertion that
an LLM did either.

---

## 2. The A-vs-B decision, and why hard-seam hybrid

Three proposals were evaluated for how to harden the AgentSpec workflow. They
converged on a hybrid and all correctly rejected the fake-dispatch anti-pattern.
The locked decision is a **hard-seam hybrid, not a blend.**

### The rejected extremes

**Pure-B (just write better markdown) — rejected.** "Tested end-to-end" is
impossible against prose. You cannot write a vitest assertion that an LLM ordered
files by dependency or honored a checkbox. AgentSpec's own `build.md` proves the
failure mode:

- topological ordering lives as "Step 3" *reasoning* the model is asked to perform;
- the "max 3 retry" cap is a *prose line* (line 199);
- the build gate is a **self-marked checkbox** (lines 206–216) — the LLM marks its
  own work done.

Every one of those is a place where correctness depends on the model behaving,
with nothing underneath to catch it when it doesn't.

**Pure-A (the CLI runs the agents) — rejected harder.** End users of a Claude Code
plugin have no SDK key, no dispatch endpoint, and no Workflow runtime. Any node
code that "runs the agent" is either the `api.anthropic.com/dispatch` fantasy from
ECC's autonomous-agent-harness or a non-deterministic `claude -p` shell-out that
breaks testability and the plugin sandbox. This is the fake-dispatch anti-pattern,
and it is forbidden.

### The seam

```
┌─────────────────────────────────────────────────────────────────────┐
│  DETERMINISTIC  (spin — TypeScript, vitest-tested, NEVER calls model)  │
│  • Kahn topo-order over schema.yaml      • named gates (exit-code ABI)│
│  • structural validation (Zod)           • run-state ledger          │
│  • criteria set-diff                      • model-route policy        │
└─────────────────────────────────────────────────────────────────────┘
                              ▲   │
                  exit code   │   │  spin <cmd>
                  + JSON      │   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AUTHORING  (slash commands — the ONLY model-execution layer)        │
│  • call spin for every decision, branch on exit code                  │
│  • fan out worker subagents via Task                                  │
│  • workers write markdown artifact + JSON handoff sidecar            │
└─────────────────────────────────────────────────────────────────────┘
                              ▲   │
                              │   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SHARED  (schemas/ — editable workflow definition, consumed by both) │
│  schema.yaml · templates/ · handoffs/*.json                          │
└─────────────────────────────────────────────────────────────────────┘
```

Deterministic concerns live in `spin` behind an exit-code ABI. Authoring concerns
live in commands via `Task`. `schemas/` is the shared, editable workflow
definition that both consume. **Every arrow in the protocol — `spin next` →
`Task` fan-out → `spin complete --handoff` → `spin gate` — is a CLI call a test can
assert.** That is the differentiator: testability is not added on top, it is the
shape of the architecture.

### What each proposal contributed to the lock

- **Proposal 1 (Opus)** — the load-bearing keystones: a **CLI-written run-state
  ledger** so gates read filesystem + state (never conversation memory), making
  them idempotent and crash-safe; and **`spin complete <id> --handoff out.json`** as
  the single point where worker output is validated against a Zod schema *before*
  the artifact counts done.
- **Proposal 3 (fidelity)** — preserve the roster intact: AgentSpec's specialist
  agents + 24 KB domains + deep DE surface are its whole reason to exist; harden
  control flow without diluting domain depth. (53 specialist agents are ported
  intact; the 5 old workflow agents are replaced by 13 typed harness workers —
  65 routed agents in total.) Also: separate the human-facing markdown artifact
  from the machine-facing handoff sidecar the gate evaluates.
- **Proposal 2 (ergonomics)** — progressive adoption: commands detect `.spindle/` and
  degrade gracefully.

---

## 3. Components

### 3.1 Artifact graph (the dependency engine)

Ported **verbatim** from OpenSpec (`src/core/artifact-graph/`): the `ArtifactGraph`
class with Kahn's algorithm for `getBuildOrder` / `getNextArtifacts` / `getBlocked`
/ `isComplete`, a Zod-validated `SchemaYaml` loader, and a DFS cycle detector that
reports the cycle path. The graph is the deterministic answer to "what is ready to
work on next, given what is already complete?"

The OpenSpec `Artifact` schema (`id`, `generates`, `description`, `template`,
`requires[]`) is **extended with four fields** the SDD workflow needs:

| Field | Purpose |
|---|---|
| `model` | per-artifact authoring tier hint (`opus`/`sonnet`/`haiku`), surfaced by `spin next` |
| `handoff` | path to `schemas/handoffs/<id>.json` — the typed worker-output contract `spin complete --handoff` enforces |
| `validate` | declarative structural checks (`md_sections`, `criteria_ids` prefix, `manifest_table` bool) run by `spin validate` |
| `parallel_group` | marks an artifact whose workers fan out as a wave — finally *executes* OpenSpec's `getNextArtifacts` wave instead of only displaying it |

Plus a top-level `config` block (e.g. `build_retry_cap: 3` — caps as **data, not
prose**) and a `gates` map (`before_design: G_DEFINE`, `before_build: G_DESIGN`,
`before_ship: [G_BUILD, G_SHIP]`).

The same engine drives both `schemas/sdd` and `schemas/kb`, so **KB creation is
just another artifact graph.** Editing a workflow means editing one YAML plus its
templates; `spin schema validate` Zod-checks it (catching cycles and dangling
`requires` before use).

### 3.2 Run-state ledger (the crash-safe keystone)

`src/core/run/run-state.ts` performs atomic read/write of **`.spindle/run.json`**: the
current schema, feature, completed set, retry counters, and gate ledger. It is
**CLI-written only — never LLM-written.** Every read is validated against a Zod
`RunState` schema (`run-state.schema.ts`).

This is the insight that makes gates trustworthy. Gates read **filesystem +
run-state only, never conversation memory.** That makes them:

- **idempotent** — running a gate twice from identical files yields an identical
  verdict (proven by idempotent-re-run unit tests);
- **crash-safe** — if the plugin dies mid-session, the next invocation reconstructs
  state from disk; no progress is lost and no artifact is silently re-counted.

State has a **dual source**: `state.ts` detects completion both via file-existence
over the `generates` path (OpenSpec's `detectCompleted` insight) *and* via the
union with the CLI-written completed set — so a completed artifact survives even if
its output file is later touched.

### 3.3 The gates

A gate is a pure function `(ctx: GateContext) => GateResult`. It reads filesystem
and run-state, never conversation. `spin gate <id>` runs it and maps
`passed: false` to **exit 1** with JSON `{ gate, passed, reasons, unmet }`.

**Eight gates are invokable via `spin gate <id>`** (the eight in `registry.ts`
below). **`G_HANDOFF` is not** — it is the validation enforced *inside*
`spin complete --handoff` (so it has nowhere to be skipped), listed here for
completeness. `spin gate G_HANDOFF` returns "unknown gate".

| Gate | When | Blocks if… | Tier |
|---|---|---|---|
| `G_DEFINE` | before `/design` | DEFINE missing required `##` sections (Why/What/Acceptance Criteria), OR zero acceptance criteria with stable `AC-n` IDs, OR define handoff fails Zod | opus-critical |
| `G_DESIGN` | before `/build` | DESIGN missing file-manifest table, OR a manifest row lacks file/action/purpose, OR no Decisions section | — |
| `G_BUILD` | before `/ship` | **any manifest file not present on disk**, OR criteria-diff(DEFINE, BUILD) non-empty, OR BUILD_REPORT missing | opus-critical |
| `G_SHIP` | inside `/ship` | `define.criteria` minus `build.passed` is non-empty (unmet acceptance criteria), OR SHIPPED artifact incomplete | — |
| `G_HANDOFF` | every `spin complete --handoff` | worker output JSON fails its declared handoff Zod schema | — |
| `G_KB_STRUCTURE` | during KB authoring | domain dir missing manifest/index/quick-reference, OR zero concept files | — |
| `G_KB_COVERAGE` | before KB complete | a manifest-declared concept has no file, OR test-cases below configured N | — |
| `G_ROUTER_COVERAGE` | gen-router, before writing routing.json | any agent frontmatter invalid, OR an agent missing from routing, OR an agent appears more than once (bijection broken) — **no silent skip** | opus-critical |
| `G_REVIEW_BLOCK` | `/review` and `/migrate`, after adversarial pass | count of surviving CRITICAL findings over validated `Finding[]` > 0 | opus-critical |

**`G_BUILD` is the centerpiece.** It does real file-existence checks over the
design manifest plus a criteria set-diff in TypeScript — this **replaces** the
AgentSpec `build.md` prose checkbox and "max 3 retry" line. The build phase can no
longer be marked done by a confident LLM; it is done when the files exist and the
criteria are met, as observed by code.

The four opus-critical gates (`G_DEFINE`, `G_BUILD`, `G_ROUTER_COVERAGE`,
`G_REVIEW_BLOCK`) are authored at the Opus tier because they are correctness- and
security-adjacent. `G_REVIEW_BLOCK` and `G_ROUTER_COVERAGE` in particular close
known holes: the Python router's `[WARN] Skipping path` silent-skip, and the
"LLM is the final judge of a CRITICAL finding" gap.

### 3.4 Handoff contracts (the validation seam)

A worker produces **two outputs**: a human-facing markdown artifact (e.g.
`DEFINE.md`) and a machine-facing JSON handoff sidecar (e.g.
`.spindle/features/<feature>/.handoffs/define.json`). Gates and `spin complete` trust
the JSON; humans read the markdown. This separation removes the brittleness of
regex-scraping markdown for a "clarity score."

`schemas/handoffs/*.json` define the contracts; `src/core/handoff/schemas.ts`
holds the Zod equivalents. There are **nine handoff schema ids**:

```
define · design · build-task · build-report · finding ·
claim · migration-plan · claudemd-section · kb-concept
```

The keystone command is:

```bash
spin complete <id> --handoff <sidecar>
```

This is a **single atomic command**: it validates the handoff JSON against the
artifact's declared schema (this is `G_HANDOFF`) **first**, and only then marks the
artifact complete in `run.json`. **Exit 1 if the handoff is invalid.** There is no
skippable seam between "validate" and "mark done" — a worker that returns prose
instead of valid JSON cannot be marked complete by hand or by accident. This closes
the self-marking hole that pure-prose and the "two separate optional steps"
ergonomic design both reopen.

`spin handoff-check <schemaId> <file.json>` exposes the same validation
standalone for debugging.

### 3.5 Model-route policy

`src/core/model-route/policy.ts` is a **pure, unit-tested resolver**:
`taskKind + budget → { tier, model, reason }`. It is consumed two ways — statically
as the `model:` field per artifact/agent, and dynamically via
`spin route <kind> [--budget low|std]`. Full doctrine in §6.

### 3.6 The CLI

`bin/spin.js` (`#!/usr/bin/env node` → `import { runCli }`) is the verbatim OpenSpec
bin pattern. `src/cli/index.ts` is the commander root: it registers every
subcommand and maps `Result` objects to the exit-code ABI, printing JSON to
stdout. Inside a plugin command, `spin` is shorthand for:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>
```

**Command surface (the whole surface — nothing else exists):**

| Command | Purpose |
|---|---|
| `spin init --schema <sdd\|kb> --feature <slug>` | scaffold `.spindle/`, copy editable schema, create `run.json` |
| `spin next` | `{ ready:[{id,model,parallel_group}], blocked:{}, complete:bool }` |
| `spin order` | full Kahn build order (inspection/debug) |
| `spin state` | print the `run.json` ledger (`completed[]`, `retries{}`, `gates{}`) |
| `spin complete <id> [--handoff f.json]` | validate handoff, **then** mark complete; exit 1 if invalid |
| `spin validate <id\|path>` | structural checks (md sections / manifest table / criteria IDs); exit 0/1 |
| `spin gate <gateId> [--agents d] [--routing f] [--findings f]` | run a named gate; exit 0 pass / 1 BLOCK with `{gate,passed,reasons,unmet}` |
| `spin diff-criteria --define f --build f` | set-diff DEFINE criteria vs BUILD passed → `unmet[]` |
| `spin handoff-check <schemaId> <file.json>` | standalone handoff validation |
| `spin retry <id> --inc \| --ok` | retry counter vs `config.build_retry_cap`; `--ok` exits 1 at ceiling |
| `spin route <taskKind> [--budget std\|low]` | model tier for an agent: `{ tier, model, reason }` |
| `spin tier [--risk \| --breadth \| --have-context \| --mechanical \| --reversible \| --irreversible]` | orchestration tier T0/T1/T2 — how much orchestration the whole task deserves (main loop / one agent / fan-out) |
| `spin kinds` | list the known routing task-kinds |
| `spin schema show\|validate` | inspect / Zod-validate the active editable schema |

**Exit-code ABI (commands branch on this):**

```
0 = pass
1 = gate blocked / handoff invalid
2 = usage error
3 = internal error
```

---

## 4. `.spindle/` on-disk layout

```
.spindle/
├── run.json                                   # the ledger (CLI-written ONLY)
├── schema.yaml                                # the active editable workflow
└── features/<feature>/
    ├── <ARTIFACT>.md                          # human-facing markdown artifact
    └── .handoffs/<id>.json                    # machine-facing handoff sidecar
```

`run.json` is never touched by an LLM. Markdown artifacts are read by humans;
handoff sidecars are evaluated by gates.

---

## 5. The harness protocol

Every workflow command obeys the same five-step loop. Deterministic decisions live
in `spin`; authoring lives in workers; control flow branches on exit codes.

```
        ┌──────────────────────────────────────────────────────────┐
        │                  SLASH COMMAND (model)                    │
        └──────────────────────────────────────────────────────────┘
                                   │
                                   ▼
        ① spin next ──────────────► { ready:[{id, model, parallel_group}], blocked }
                                   │
                                   ▼
        ② for each ready artifact:
             spin route <kind>  (or use the artifact's model hint)
             dispatch a worker via Task on that tier.
             ┌─ same parallel_group → fan out in ONE message ─┐
             │   Task(worker A)   Task(worker B)   Task(C)     │   (true parallel)
             └───────────────────────────────────────────────┘
                                   │
                                   ▼
        ③ worker writes:  <ARTIFACT>.md   +   .handoffs/<id>.json
                                   │
                                   ▼
        ④ spin complete <id> --handoff <sidecar>
             ├─ exit 0 → artifact counted done in run.json
             └─ exit 1 → handoff INVALID:
                  spin retry <id> --inc
                  spin retry <id> --ok   (exit 1 at ceiling → STOP)
                  else re-dispatch worker  ← bounded loop, cap is DATA
                                   │
                                   ▼
        ⑤ spin gate <gateId>   (for the phase)
             ├─ exit 0 → advance to next phase
             └─ exit 1 → STOP. surface {reasons, unmet}. do not advance.
```

1. **`spin next`** to learn the ready artifact(s) and their model hint.
2. For each ready artifact, read `spin route <kind>` (or the artifact's hint) and
   dispatch a worker via `Task` on that model. Independent artifacts/files in the
   same `parallel_group` fan out in a **single message** (true parallel).
3. The worker writes its markdown artifact **and** its JSON handoff sidecar.
4. **`spin complete <id> --handoff <sidecar>`.** Exit 1 means the handoff is
   invalid: re-dispatch, bounded by `spin retry <id> --inc`, stopping at the
   `--ok` ceiling. **NEVER mark complete by hand.**
5. **`spin gate <gateId>`** for the phase. Exit 1 → STOP, surface `{reasons,
   unmet}`, do not advance. Exit 0 → proceed.

The retry cap is enforced by `spin retry` against `config.build_retry_cap` in the
schema — a counter in run-state, **not** a prose "max 3" line a model can
rationalize past. This is the bounded loop done correctly: typed and capped via the
CLI, with **no `claude -p` and no dispatch** (explicitly correcting the bad ECC
autonomous-loops skill).

---

## 6. Model-routing policy

Routing is **first-class, pure, and unit-tested** (`policy.ts` + `policy.test.ts`).
The default is: **route to the cheapest tier that can *verifiably* do the task.**

| Tier | Used for | Task kinds |
|---|---|---|
| **HAIKU** (mechanical, gate-backstopped) | extraction & assembly a gate can catch | `file-read`, `structure-extract`, `frontmatter-parse`, `template-fill`, `format-convert`, `claim-extract`, `ship-prose`, `section-scan`, `router-assemble` |
| **SONNET** (analysis / authoring / synthesis) | the bulk of authoring | `spec-authoring`, `design-synthesis`, `code-build`, `kb-concept`, `finding-analysis`, `claim-verify`, `migration-plan`, `merge` |
| **OPUS** (deepest reasoning + adversarial) | intent & judgment | `architect`, `define-intent`, `design-intent`, `adversary`, `review-judge`, `equivalence-break` |

**Two hard, enforced principles:**

1. **The verifier outranks-or-equals the generator on any CRITICAL gate.** An Opus
   adversary challenges a Sonnet build. **The cheaper tier is never the final judge
   of a CRITICAL finding.** `policy.test.ts` asserts critical kinds never resolve
   below their floor.
2. **Tier downgrades are free ONLY where a deterministic gate backstops the
   output.** Haiku does extraction because `spin validate` catches its mistakes.
   `--budget low` shifts authoring Sonnet→Haiku **only where a gate exists**, and
   **NEVER** downgrades the adversary or architect kinds. Critical kinds
   (`adversary`, `architect`, `review-judge`, `*-intent`) never downgrade under any
   budget.

This is why cost is controllable without sacrificing correctness: the gates make
cheap tiers safe exactly where they are cheap, and refuse to make them final judges
where the stakes are high.

---

## 7. E2E test strategy — why it proves correctness

The deliverable test is **`test/e2e/sdd-cycle.e2e.test.ts`**. It drives the full
five-phase cycle through the **real CLI** (spawning `node bin/spin.js`
subprocesses), simulating the model layer with deterministic fixture files the test
itself writes — **including one deliberately-broken state** (only 1 of 2 manifest
files present). No LLM, no network, no mock API. It runs in seconds.

```
spin init --schema sdd
spin next                       → assert ready includes `define`
  write DEFINE fixture + define handoff sidecar
spin validate define            → exit 0
spin complete define --handoff  → asserts G_HANDOFF passes
spin gate G_DEFINE              → exit 0
spin next                       → ready: [design]
  write DESIGN with file manifest
spin complete design --handoff
spin gate G_DESIGN              → exit 0
spin next                       → ready: [build]
  write ONLY file1 of the manifest          ← the deliberately broken state
spin gate G_BUILD               → ASSERT EXIT 1, unmet: [file2]   ◄ proves it BLOCKS
  write file2 + BUILD_REPORT
spin gate G_BUILD               → exit 0                          ◄ proves it advances
spin diff-criteria              → unmet: []
spin gate G_SHIP                → exit 0
spin state                      → phase: ship, complete: all
```

**Why this proves correctness and prose cannot.** The test asserts the harness
**blocks when it should** (exit 1 on the missing manifest file) and **only advances
when state is real** (exit 0 after the fix). That is a property no prose-only design
can be tested for — you cannot assert that an LLM blocked itself on a missing file.
Here the assertion is on a process exit code observed by the test runner.

Supporting tests:

- **`test/e2e/kb-cycle.e2e.test.ts`** — drives the KB graph through the CLI;
  `G_KB_COVERAGE` blocks until every manifest concept exists.
- **`test/cli/cli.test.ts`** — asserts the exit-code ABI per command (spawns the
  subprocess against a temp dir).
- **`router-gate.test.ts`** — inject a duplicate agent → `G_ROUTER_COVERAGE` exit 1;
  malformed frontmatter → exit 1; clean roster → exit 0.
- **Every gate has a pass + fail + idempotent-re-run unit test** — running a gate
  twice from identical files yields an identical result, proving crash-safety
  (gates read filesystem + run-state, never conversation).
- **A grep-guard test fails CI if `src/` contains `fetch(` / `anthropic` /
  `claude -p`**, mechanically enforcing the no-model-calls invariant.

CI runs `node build.js` + `vitest run` on every push, with an 80% coverage gate on
`src/core`.

---

## 8. Provenance — what was ported from where

The harness is mostly **ported, not invented.** The deterministic spine is
OpenSpec's proven code; the domain depth is AgentSpec's roster intact; the
adversarial and routing doctrine is the *good* parts of ECC. The genuinely new
work is the seam between them.

| From | What | How |
|---|---|---|
| **OpenSpec** | `graph.ts` (Kahn order), `schema.ts` (loader + cycle detection), `types.ts`, `state.ts` (`detectCompleted`), `outputs.ts` | **Ported verbatim** — confirmed clean, MIT, Zod-validated, cycle-detecting. `types.ts` *extended* with `model`/`handoff`/`validate`/`parallel_group`/`config`/`gates`. |
| **OpenSpec** | ship mechanics: `package.json` (bin `spin`, esbuild, vitest), `tsconfig`, `build.js`, `bin/spin.js`, `vitest.config`, CI | Ported so npx/node install works offline. |
| **AgentSpec** | 53 specialist agents, 24 KB domains, the whole DE command surface (pipeline/schema/data-quality/data-contract/lakehouse/ai-pipeline), data-engineering-guide skill, `judge.py`, plugin manifest | **Ported intact** — preserves domain depth, the fidelity constraint. The 5 old workflow agents become 13 typed harness workers (`define-worker`, `build-worker`, `_adversary/challenger`, …); 65 routed agents in total. |
| **AgentSpec** | the SDD workflow itself (`WORKFLOW_CONTRACTS.yaml`, the DEFINE/DESIGN/BUILD/SHIP templates) | Encoded as **data** in `schemas/sdd/schema.yaml` + `templates/`. The brittle parts (`build.md` topo-as-reasoning, prose retry, self-marked checkbox) are *rewritten* into gates. |
| **ECC** | model-routing doctrine (`policy.ts`), the `_adversary/challenger` role, the `adversarial-gate` / `parallel-fanout` / `bounded-loop` skills | Ported as the **good** ECC patterns — explicitly **NOT** the fake-dispatch / `claude -p` autonomous-agent-harness skill, which is corrected by `bounded-loop`. |
| **NEW** | the hard seam: `run-state.ts` + ledger, the gate registry + runner, `G_*` gate implementations, `criteria-diff.ts`, `handoff/` schemas + `spin complete --handoff` enforcement, `model-route/policy.ts`, `schemas/kb`, the rewritten harness-aware commands, the harness-protocol & model-routing skills, the full E2E + grep-guard test suite | This is the testability layer — every CLI call a test can assert. |

---

## 9. Known residual risks

These are tracked, not solved-and-forgotten:

- **Install reach (highest).** A Claude Code plugin ships markdown and does not
  auto-run `npm install`, so `spin` must reach the user's shell. Locked default:
  commit prebuilt `dist/` in the plugin and invoke via
  `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js"` (offline, self-contained); a
  `SessionStart` hook runs `node build.js` if `dist/` is missing. `build.js`
  also syncs `dist/` + `schemas/` into `plugin/` so `${CLAUDE_PLUGIN_ROOT}/dist`
  resolves on a real plugin install. Validated by an offline smoke test (CI's
  `bundle-self-contained` job). Building from source (`npm run build`) is the
  documented fallback until an npm/marketplace package is published.
- **Worker non-compliance.** A subagent may return prose instead of JSON.
  Mitigated because `spin complete --handoff` exits 1 on invalid JSON, forcing the
  bounded-loop re-dispatch — but the command body must actually branch on that exit
  code. The harness-protocol skill makes exit-code branching mandatory.
- **Sidecar drift.** The markdown artifact and the handoff JSON can diverge. Gates
  trust the JSON; humans read the markdown. `spin validate` can cross-check that key
  fields (criteria IDs) appear in both; not fully closed in MVP.
- **Schema-fork footgun.** Users editing `schema.yaml` can introduce a cycle or
  dangling `requires`. `spin schema validate` (and `parseSchema` on every load)
  catches it via the ported DFS cycle + dangling-ref checks.
- **Cost.** Opus on define/design/build-adversary is the default; the adversarial
  + opus-authoring passes dominate spend on large features. `--budget low`
  downgrades *gated* authoring to Haiku/Sonnet, but **never** the adversary or
  architect kinds — budget-conscious users opt in explicitly.

---

*This document is the architecture source of truth. The locked specification is
`docs/ARCHITECTURE_LOCKED.json`; the `spin` CLI surface and harness protocol are
defined in `docs/_authoring_context.md`. When a canonical architectural decision
changes, update this file.*
