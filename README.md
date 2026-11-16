# Spindle

**A shared spec-to-ship workflow for AI coding assistants.** Start a feature in one assistant, continue it in another, and review the same acceptance criteria, test references, and gate decisions in the project.

Spindle is for developers and teams shipping changes that need a reviewable record of what was agreed, built, and checked. For example, define a payments reconciliation feature in Gemini CLI with `AC-1` requiring duplicate imports to leave balances unchanged. Implement it in Cursor and record the test against `AC-1` in the build report. A reviewer on Codex or Claude Code can find the criterion, its test reference, and the gate verdict in the same checkout.

## Start here

Requires Node.js 20.19 or newer. Clone Spindle, then install into the project where you want to use it:

```bash
git clone https://github.com/ivisribeiro/spindle.git
node ./spindle/bin/spindle-install.js --target all --root /path/to/your/project
cd /path/to/your/project
node .spindle/harness/bin/spin.js doctor
```

Open your assistant from the project root and invoke Spindle:

| Assistant | Invoke | Project file |
|---|---|---|
| Codex | `$spindle-workflow` | `.agents/skills/spindle-workflow/SKILL.md` |
| Claude Code | `/spindle-claude-workflow` | `.claude/skills/spindle-claude-workflow/SKILL.md` |
| Gemini CLI | `/spindle` | `.gemini/commands/spindle.toml` |
| Cursor | `/spindle-workflow` | `.agents/skills/spindle-workflow/SKILL.md` |
| Other assistants with local file and shell access | Ask it to read and follow `.spindle/harness-workflow.md` | `.spindle/harness-workflow.md` |

Ask the assistant to start the SDD workflow for `payments-reconciliation`, or ask it to show the next step in an existing run. When switching assistants, use the same checkout. Ask for `status` to inspect the run or `resume` to continue the earliest unfinished main phase. Each checkout has one active run. Use one orchestrating session at a time so each phase sees the current ledger.

Use `--target codex`, `claude`, `gemini`, `cursor`, or `portable` to install for a single environment. Rerun the installer to update. It checks for conflicts and preserves locally edited integration files. If the project ignores `.spindle/`, each teammate runs the installer in their own checkout to get the local runtime.

The portable workflow covers brainstorm, define, design, build, ship, iteration, status, and resume. The [native Claude Code plugin](#native-claude-code-plugin) also includes audit, knowledge-base authoring, specialist workflows, and cross-vendor review.

## What Spindle checks

- **Acceptance criteria carry through the build.** Define assigns IDs such as `AC-1`. `G_DEFINE` checks that the Markdown and JSON handoff list the same criteria. The build report records results against those IDs. `G_BUILD` checks for missing criteria and undeclared criteria reported as passed. It can require a verifier reference and block when supplied CI evidence reports a failed verification.
- **Spec corrections stay visible.** A build can record that it corrected a criterion. `G_SHIP` blocks while any recorded correction remains unreconciled.
- **Shipping requires a sign-off.** The developer runs `spin approve` from an interactive terminal. `G_SHIP` checks the recorded approval. `spin invalidate` clears approval and gate verdicts and reopens the affected work.
- **The project keeps the evidence.** `.spindle/` holds the editable workflow, Markdown artifacts, JSON handoffs, and the run-ledger. `spin trace` shows recorded completions, gate verdicts, retries, and approval.

The assistant authors specs, implementation, and evidence. The model-free `spin` CLI validates handoffs and returns an exit code deciding whether the workflow can advance. The checks cover file references, criteria consistency, and structured evidence. Correctness still depends on meaningful tests and review. The approval command checks for an interactive terminal. Teams that need to authenticate a reviewer should use their repository’s review controls. See [STATUS.md](STATUS.md) and the [PIX reconciliation dogfood log](docs/DOGFOOD_LOG_pix-brcode.md).

---

## The workflow boundary

```text
Codex · Claude Code · Gemini CLI · Cursor · other assistants
                │ author artifacts and call spin
                ▼
             spin CLI
                │ validate handoffs, enforce gates, record verdicts
                ▼
        Project files and .spindle/
```

`spin` reads `.spindle/run.json`, orders work using the artifact graph, validates handoffs against JSON schemas, and records gate verdicts. It runs locally and never calls a model. Assistants branch on the CLI exit code for ordering, validation, and phase transitions. Only `spin` writes the run-ledger.

---

## The measured harness

Routing *predicts*, gates *block* — and a third deterministic layer **measures** whether either was right, closing the loop back into the harness. All of it is pure, offline reads over `.spindle/`; the model-free guard forbids tokenizers and pricing in `src/` so measurement can never grow model-awareness.

- **`spin trace`** — the run-ledger: an append-only `events[]` timeline (`complete`/`gate`/`retry`/`approve`) with a tier histogram and summed reported tokens. A pure read, exit 0. Events are **hash-chained** (each carries a sha256 over its content + the previous hash), and `spin trace --verify` walks the chain — exit 1 names the first broken link, so a hand-edited history is tamper-*evident* (the state maps remain plain JSON; see STATUS.md for the honest residual limit).
- **`spin eval`** — replays a corpus of recorded fixtures through the **real** gate functions; a gate that stops blocking what it used to block is a regression CI catches, with no model and no network. `--strict` is fail-closed on incomplete coverage — and the bundled corpus now covers **all 11 registry gates** with a pass *and* a block fixture, so `npm run eval` runs `--strict` green in CI (a new gate without fixtures fails the build).
- **`spin budget`** — reconciles model-reported token spend per tier against an optional ceiling. **Accounting, not enforcement** by default: advisory, exit 0 — the spine cannot independently verify a self-reported count. `--enforce` is the opt-in ceiling (flag or `config.max_tokens`): exit 1 on overage, and the output always carries `self_reported: true` so nobody mistakes it for measured spend.
- **`spin route --stats`** — advisory per-tier accounting aggregated from the ledger (completions, reported tokens, retries per artifact). Same doctrine: it informs routing-table edits, it never enforces.
- **`spin doctor`** — read-only orientation: node version, run health, schema validity, gate verdicts, and the suggested next phase. Use the installed assistant entry point above to request that phase.
- **`spin verify-self`** in the Spindle source checkout recomputes sha256 over both built CLI bundles and every schema file against `verification/checksums.json` (written at build). The "dist is build output, never hand-edit" invariant becomes checkable, with node builtins only.

See [`docs/MEASUREMENT.md`](docs/MEASUREMENT.md) for the doctrine and its honest limits.

---

## Install

### Native Claude Code plugin

Register the bundled marketplace and install the plugin:

```bash
git clone https://github.com/ivisribeiro/spindle.git
cd spindle
claude plugin marketplace add ./
claude plugin install spindle@spindle
```

`plugin/` ships the prebuilt, self-contained `dist/cli/index.js` (deps inlined,
runs offline) and `schemas/`, so the slash commands work with no `npm install`.
The native plugin's commands invoke the CLI as:

```bash
node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>
```

The documented shorthand throughout this README is `spin <args>`.

> **Session-only alternative** (`--plugin-dir`): `claude --plugin-dir ./spindle/plugin`
> loads the plugin for that session only and does not persist across restarts.

### Build from source or use the CLI directly

```bash
git clone https://github.com/ivisribeiro/spindle.git
cd spindle && npm install && npm run build
node bin/spin.js <args>      # the `spin` CLI
```

### Use the bundled CLI

Invoke `node /path/to/spindle/bin/spin.js` from your project root to use the checkout’s bundled CLI and schemas. A project installed with `spindle-install` can use `node .spindle/harness/bin/spin.js`. In the examples below, `spin` stands for your installed CLI.

---

## Command surface

| Command | What it does | Exit codes |
|---|---|---|
| `spin init --schema <sdd\|kb\|brownfield> --feature <slug> [--force]` | Scaffold `.spindle/`, copy editable schema to `.spindle/schema.yaml`, create `run.json`. **Refuses to clobber an in-progress run** (exit 1) unless `--force` — a human-only escape hatch | 0 / 1 / 2 |
| `spin next` | `{ feature, ready:[{id,model,parallel_group}], blocked:{}, gate_blocked:{}, detected_on_disk:[], complete:bool }` — readiness is **ledger-authoritative + gate-aware**: an artifact is `gate_blocked` until the lifecycle gate before it is green; a stray `.md` only shows in `detected_on_disk`, never `ready` | 0 |
| `spin order` | Full Kahn build order for the active schema | 0 |
| `spin state` (alias `spin status`) | Print the `run.json` ledger (`completed[]`, `retries{}`, `gates{}`) | 0 |
| `spin explain <gateId>` | What a gate reads, what blocks it, which flags apply — no source-diving | 0 / 2 |
| `spin complete <id> [--handoff f.json]` | Validate the worker handoff against the artifact's schema, then mark complete. **exit 1** if the handoff is invalid, a lifecycle gate required before `<id>` (schema `gates:` map — incl. the terminal `during`/`before_complete` hooks on the final artifact) hasn't passed, a predecessor is absent from the ledger, or a handoff-less artifact's `generates` output is missing on disk. A stray `--handoff` on a handoff-less artifact is a usage error | 0 / 1 / 2 |
| `spin validate <id\|path>` | Structural checks (MD sections / manifest table / criteria IDs) | 0 / 1 |
| `spin gate <gateId> [--agents d] [--routing f] [--kb d] [--findings f]` | Run a named gate. exit 0 = pass, exit 1 = BLOCK with `{gate,passed,reasons,unmet}`. An **unknown** gate id is a usage error (exit 2) and writes nothing to the ledger | 0 / 1 / 2 |
| `spin diff-criteria --define f --build f` | Set-diff DEFINE criteria vs BUILD passed → `unmet[]` | 0 / 1 |
| `spin handoff-check <schemaId> <file.json>` | Standalone handoff validation | 0 / 1 |
| `spin retry <id> --inc \| --ok` | Retry counter vs `config.build_retry_cap`. `--ok` exits 1 at ceiling | 0 / 1 |
| `spin route <taskKind> [--budget std\|low]` · `spin route --stats` | Model tier for an agent: `{ tier, model, reason }`; `--stats` aggregates advisory per-tier outcomes (completions, tokens, retries) from the ledger | 0 / 2 |
| `spin tier [--risk\|--breadth\|--have-context\|--mechanical\|--reversible\|--irreversible]` | Orchestration tier T0/T1/T2 — main loop / one agent / fan-out | 0 |
| `spin reconcile --audit f.json` | Doc-vs-code drift over an audit handoff | 0 / 1 |
| `spin config-drift --declared a,b --present a` | Tools required by CI but absent from the lockfile | 0 / 1 |
| `spin spec-drift --build f.json` | Acceptance criteria the build CORRECTED vs DEFINE (`corrected_spec`) — a false spec can't ride a green build | 0 / 1 |
| `spin schema show\|validate [handoffId]` | Inspect/validate the active schema; `show <handoff-id>` describes a handoff JSON shape | 0 / 1 / 2 |
| `spin approve [--by <name>]` | Record human sign-off (required by `G_SHIP`). **Refuses unless run in an interactive TTY** — the workflow asks the human to run it | 0 / 2 |
| `spin invalidate <id>` | After an `/iterate` edit: drop `<id>` + its downstream closure from the ledger and void all gate verdicts + approval, so no stale-green survives | 0 / 2 |
| `spin trace [--verify]` | Print the run-ledger timeline (`events[]`) + a tier/token summary — a pure read. `--verify` walks the event hash chain: exit 1 names the first broken link | 0 / 1 |
| `spin eval [--strict]` | Replay the eval corpus through the **real** gates; exit 1 on any verdict regression. `--strict` also fails if a registry gate lacks a pass+block fixture | 0 / 1 |
| `spin budget [--max-tokens n] [--enforce]` | Reconcile reported token spend per tier vs an optional ceiling. Advisory by default (exit 0); `--enforce` (flag or `config.max_tokens` ceiling) exits 1 on overage, always marked `self_reported: true` | 0 / 1 / 2 |
| `spin fanout-check [--manifest f] [--handoffs d]` | Ledger mode: assert no `parallel_group` is partially complete. File mode (`--manifest`): compare the design manifest to per-file `build-task` sidecars — `missing[]` is the exact re-dispatch payload for a dropped build worker | 0 / 1 / 2 |
| `spin doctor` | Read-only orientation: env, run health, schema validity, and suggested next phase | 0 |
| `spin verify-self` | Recompute sha256 of both dist bundles + all schemas vs `verification/checksums.json`; exit 1 names tampered/missing files | 0 / 1 / 2 |
| `spin merge-findings <files...> [--out f]` | Deterministically merge N finding files (dedup by file+line+rule, keep higher severity, aggregate `sources`) into one `{findings,sources}` for `G_REVIEW_BLOCK` | 0 / 1 |
| `spin kb-install <domain> [--from][--dest]` | Publish a generated KB domain (flat layout) from `.spindle/` into `plugin/kb/` so `kb_domains` resolves; pure file copy | 0 / 1 / 2 |
| `spin kinds` | List known routing task-kinds | 0 |

**Exit-code ABI:** `0` = pass · `1` = gate blocked / handoff invalid · `2` = usage error · `3` = internal error

---

## Gates

Gates are run via `spin gate <id>`. A command that receives exit 1 surfaces `{gate, passed, reasons, unmet}` and stops — it does not advance the phase.

| Gate ID | Fires before | Checks |
|---|---|---|
| `G_DEFINE` | `/design` | DEFINE sections present (`Why`/`What`/`Acceptance Criteria`), define handoff valid, optional clarity floor met |
| `G_DESIGN` | `/build` | DESIGN sections present (`Overview`/`File Manifest`/`Decisions`), a file-manifest table present, design handoff valid |
| `G_BUILD` | `/ship` | Every manifest file exists on disk; every DEFINE criterion `passed`; **no phantom criterion** (a `passed` AC-n DEFINE never declared → set-drift); a cited `verified_by` file must exist; **a passed criterion whose CI verifier reported `failed` blocks** (the spine reads the CI result, never runs the verifier); when `config.require_verified_by`, every passed criterion must cite a verifier; manifest/`verified_by` paths must stay inside the project root (no `..` escape); when a CI `coverage` summary is reported, its `pct` must meet its `threshold`; BUILD_REPORT present |
| `G_SHIP` | archive | DEFINE criteria minus build.passed must be empty; no phantom criterion; **unreconciled spec-drift blocks** — a build that CORRECTED a criterion emits a `spec-drift:<AC>` unmet entry per affected criterion until DEFINE is reconciled (`reconciled: true`); **a human approval must be recorded via `spin approve`** in an interactive terminal |
| `G_KB_STRUCTURE` | KB publish | KB structure checks |
| `G_KB_COVERAGE` | KB publish | KB coverage checks |
| `G_ROUTER_COVERAGE` | router validate | Agent→routing bijection, no silent skips |
| `G_REVIEW_BLOCK` | `/review` · `/codex-review` · `/migrate` ship | Surviving CRITICAL findings > 0 → block |
| `G_AUDIT` | `/audit` (brownfield) | Empty audit, or a `built[]` item without evidence, or a gap without a priority |
| `G_OPS_CONFIG` | brownfield sign-off | Any `opsReadiness[]` item `enforced: false` (coded but inert-in-prod flag) |
| `G_PLAN` | before `/build` of a plan | Vague-acceptance task, L/XL task bundling >1 domain, or an unaddressed blocking gap |
| `G_HANDOFF` | (enforced inside `spin complete --handoff`) | Handoff JSON matches declared schema |

The **11** gates above the line are dispatchable via `spin gate <id>` (the gate registry — what `spin eval --strict` covers). `G_HANDOFF` is not a registry gate: it's enforced inline by `spin complete --handoff`, listed here for completeness.

**Lifecycle hooks are engine-enforced, not prose.** A workflow schema's `gates:` map accepts a closed set of hook keys — `before_<artifactId>` (green before that artifact completes or is listed ready), and the terminal `before_complete` / `during` (green before the final artifact completes and before the run reports `complete:true`). `spin complete` and `spin next` apply them directly; `spin schema validate` rejects any hook key the engine cannot anchor, so a declared hook can never be silently inert.

---

## Handoff schema IDs

Workers write a JSON sidecar matching one of these schema IDs; the slash command passes it to `spin complete --handoff <sidecar>`.

`define` · `design` · `build-task` · `build-report` · `finding` · `claim` · `migration-plan` · `claudemd-section` · `kb-concept` · `audit`

> The `audit` handoff is the **brownfield** contract — structured `built[]`/`gaps[]`/`weakPoints[]`/`opsReadiness[]`/`proposedTasks[]`/`invariants_at_risk[]` — driven by the separate `brownfield` schema (the full `audit → define → design → build → ship` cycle) and the `/audit` command, so the spine models audit-then-plan, not just greenfield. `G_AUDIT` is anchored twice: `before_define` (the run fail-fasts right after the audit phase) and terminal (it can never report complete on an un-evidenced audit). See `docs/IMPROVEMENTS_FROM_DOGFOOD.md`.

---

## Model routing

`spin route <taskKind>` returns the right tier. The native Claude Code plugin uses this to select a model tier. In the portable workflow, model selection and delegation depend on the host assistant.

| Tier | Task kinds |
|---|---|
| **HAIKU** (mechanical, gate-backstopped) | `file-read` · `structure-extract` · `frontmatter-parse` · `template-fill` · `format-convert` · `claim-extract` · `ship-prose` · `section-scan` · `router-assemble` |
| **SONNET** (analysis / authoring) | `spec-authoring` · `design-synthesis` · `code-build` · `kb-concept` · `finding-analysis` · `claim-verify` · `migration-plan` · `merge` |
| **OPUS** (deepest + adversarial) | `architect` · `define-intent` · `design-intent` · `adversary` · `review-judge` · `equivalence-break` |

**Doctrine:** default to the cheapest tier that verifiably does the task. Two hard rules: (a) the verifier/adversary outranks-or-equals the generator on any CRITICAL gate — never let a cheaper tier be the final judge; (b) downgrade a tier under `--budget low` only where a deterministic gate backstops the output. Critical kinds (`adversary`, `architect`, `review-judge`, `*-intent`) never downgrade.

---

## SDD cycle reference

In the portable workflow, invoke Spindle and name the phase. The slash commands below are from the native Claude Code plugin.

### 1. Initialise

```bash
spin init --schema sdd --feature payments-reconciliation
```

Creates `.spindle/`, `.spindle/run.json`, `.spindle/schema.yaml` (your editable copy), and `.spindle/features/payments-reconciliation/`.

### 2. Brainstorm

Run `/brainstorm --feature payments-reconciliation`. The command calls `spin next` to get the ready artifact, dispatches an **Opus** worker via Task (the `define-intent` task-kind never downgrades), the worker writes `BRAINSTORM.md` and a discovery summary in `.handoffs/brainstorm.json`. With the default SDD schema the orchestrator records completion with:

```bash
spin complete brainstorm   # requires BRAINSTORM.md
```

### 3. Define

Run `/define`. Before finishing, the command runs:

```bash
spin gate G_DEFINE
```

Exit 1 → surface `{reasons, unmet}` and stop. Exit 0 → proceed.

### 4. Design

Run `/design`. Gate fires:

```bash
spin gate G_DESIGN
```

### 5. Build

Run `/build`. The command loops over `spin next`, fanning out one worker per manifest file in the same `parallel_group` in a single Task dispatch. Each worker writes its file + a `build-task` handoff, validated independently:

```bash
spin handoff-check build-task .spindle/features/<feature>/.handoffs/<file-id>.json   # per worker
```

Then the orchestrator records ONE aggregate `build` completion and gates it (`build` is the only build-phase artifact id — `spin complete <per-file-id>` would exit 2):

```bash
spin complete build --handoff .spindle/features/<feature>/.handoffs/build.json
# exit 1 → spin retry build --inc  (bounded by build_retry_cap)
# at ceiling → spin retry build --ok  exits 1, command surfaces the block
```

When `build` completes, `spin gate G_BUILD` must pass before `/ship` is allowed.

### 6. Ship

Run `/ship`. A human must sign off **first** — in an interactive terminal:

```bash
spin approve --by "$USER"   # requires interactive stdin
spin gate G_SHIP            # requires approval on record
```

Exit 0 → the command assembles the SHIP doc and marks the feature complete. Use `spin invalidate` when reopening a completed artifact so the affected work requires a fresh gate verdict and approval.

---

## Harness protocol (the full mechanism)

Every workflow command follows these five steps — this is the whole mechanism:

```
1. spin next               → ready artifacts + model hints
2. spin route <kind>       → tier/model for each artifact
3. Author or delegate     → write artifact + handoff sidecar
4. spin complete <id> --handoff <sidecar>
      exit 1 → spin retry <id> --inc / --ok (bounded)
5. spin gate <gateId>
      exit 1 → STOP, surface {reasons, unmet}
      exit 0 → advance
```

Deterministic decisions live in `spin`. Authoring lives in workers. Control flow branches on exit codes.

---

## Flows

These flows show the portable SDD lifecycle and additional workflows available in the native Claude Code plugin.

### 1 — Greenfield SDD cycle

The spine from idea to shipped feature. Each `spin gate` is a hard stop; `spin approve` is a human, in a real terminal, before ship.

```
/brainstorm ──▶ /define ──▶ /design ──▶ /build ──────▶ /ship
     │            │            │           │              │
  BRAINSTORM   G_DEFINE     G_DESIGN    G_BUILD        G_SHIP
   + summary   (sections,   (manifest,  (files exist,  (criteria met,
                AC ids)      handoff)    AC met, CI     spec-drift clean,
                                         verifier ok)   HUMAN APPROVAL)
                                            │              ▲
                                            │        spin approve  (TTY-only)
                                            ▼
                                     spin retry --inc (bounded by build_retry_cap)
```

### 2 — Design-driven KB + specialist generation

`/design` declares `technologies[]`. The stack defines what knowledge and which specialists to generate — on demand, not from a pre-loaded catalog. A specialist **cannot ship without its KB**: `G_ROUTER_COVERAGE` checks every agent's `kb_domains` resolves.

```
/design  ──declares──▶  technologies: [iceberg, duckdb, ...]
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                            ▼
  /create-kb <tech>                          /create-specialist <tech>
   authors concepts in .spindle/              authors an agent w/ kb_domains:[<tech>]
        │                                            │
  spin kb-install <tech>                       /gen-router
   copies → plugin/kb/<tech>                         │
        └───────────────────▶ resolves ◀────── spin gate G_ROUTER_COVERAGE
                                                (kb_domains must exist on disk)
```

### 3 — Build hardening: tests + cross-vendor review + human sign-off

Three independent checks stand between a green build and a ship, each a different *verifier ≠ generator*: the CI verifier, an adversarial reviewer (Claude **and/or** OpenAI Codex, natively), and a human.

```
build worker ─▶ code + tests + build-report (verified_by + CI verified_by_result)
                     │
                     ▼
              spin gate G_BUILD ──▶ blocks a passed criterion whose CI verifier FAILED
                     │
        ┌────────────┴─────────────┐
        ▼                          ▼
   /review  (Claude)        /codex-review  (OpenAI Codex, opt-in, fail-open)
   findings (source=claude) findings (source=codex)
        └─────────┬──────────────┘
                  ▼
        spin merge-findings  ──▶  spin gate G_REVIEW_BLOCK
         (dedup, keep severity)    (surviving CRITICAL > 0 → BLOCK;
                                    --min-sources to require >1 vendor)
                  │
                  ▼
        spin approve (human, TTY) ──▶ spin gate G_SHIP ──▶ /ship
```

### 4 — Iterate cascade (no stale-green)

Run `spin invalidate` before editing a gated artifact. It removes the artifact and its downstream dependencies from the completed list and clears every gate verdict and approval. If a file was edited outside the workflow, invalidate the affected phase before relying on the ledger. The current run state does not automatically detect those edits.

```
/iterate edits DESIGN
        │
        ▼
spin invalidate design
        ├─ getDownstream(design) = { design, build, ship }   ← drop from completed[]
        ├─ gates = {}                                          ← void ALL verdicts
        └─ approval = null                                     ← void human sign-off
        │
        ▼
re-author ▶ re-gate ▶ re-approve the cascade (spin next → … → G_SHIP)
```

### 5 — Brownfield (audit-first)

For an existing codebase, the spine starts from an **audit** — structured evidence of what's built, what's missing, and what's coded-but-inert-in-prod — then flows into the same greenfield cycle, now grounded.

```
/audit ─▶ audit handoff { built[], gaps[], weakPoints[], opsReadiness[], proposedTasks[] }
   │          │
   │     spin gate G_AUDIT       (every built[] needs evidence; every gap a priority)
   │     spin gate G_OPS_CONFIG  (no opsReadiness[] item enforced:false — coded ≠ in prod)
   ▼
/define ─▶ /design ─▶ /build ─▶ /ship   (the cycle from Flow 1, grounded in the audit)
```

The engine holds the line here, not the prose: `define` stays `gate_blocked` until `G_AUDIT` is green (`before_define` hook), and the run can never report complete without it (terminal hook) — a brownfield run cannot outrun its own audit.

---

## On-disk layout

```
.spindle/
├── run.json                              # ledger (CLI-written only; never edit by hand)
├── schema.yaml                           # active editable workflow (fork this)
└── features/
    └── <feature>/
        ├── BRAINSTORM.md
        ├── DEFINE.md
        ├── DESIGN.md
        ├── BUILD_REPORT.md
        └── .handoffs/            # canonical sidecars, written by `spin complete --handoff`
            ├── define.json        #   (brainstorm has no handoff — no file)
            ├── design.json
            └── build.json         #   keyed by artifact id `build`, not the schema id
```

---

## Forking `schema.yaml`

The editable schema at `.spindle/schema.yaml` is yours to customise. It controls:

- Which artifacts exist and their dependency edges (Kahn order)
- The `model` hint per artifact (used by `spin next`)
- The `build_retry_cap` (cap for `spin retry --ok`)
- Gate configurations

```bash
spin schema show      # print the active schema
spin schema validate  # check it is well-formed
```

After editing, run `spin schema validate` before running any workflow command. The schema is intentionally small — artifact nodes + edges + a handful of config keys. Start from the `sdd` or `kb` built-in and trim or extend from there.

---

## Test and CI story

Run `npm test` for unit, integration, and end-to-end coverage of:

- Kahn ordering correctness under all dependency topologies (incl. `getDownstream` closure)
- Gate pass/block logic for every gate ID — phantom-criterion, evidence, CI-verifier-failed, `require_verified_by`, and the `G_SHIP` human-approval requirement
- The `/iterate` cascade: `spin invalidate` drops the downstream closure and voids all verdicts + approval
- Interactive approval: `spin approve` refuses non-interactive stdin
- Handoff schema validation for all 10 schema IDs
- Exit-code ABI conformance
- `spin eval` replays the corpus through the real gates so a gate that stops blocking is a caught regression
- **No-model-calls guard** — the test suite asserts that no `spin` code path imports or invokes an inference SDK. This is enforced as a hard test failure, not a lint warning.
- **Machine-verified inventory** — `npm run inventory:check` (also in CI) recounts agents/commands/gates/schemas from source and fails the build if any hand-written count in the marketplace/plugin manifests drifts from reality.
- Cycle detection in the artifact graph, the event hash chain (build/verify/tamper), the init clobber guard, budget enforcement, and file-level fanout accounting — each with pass AND fail fixtures.
- E2E: full `sdd`, `kb`, and `brownfield` cycles from `spin init` through their final gates, using fixture artifacts and handoffs, verifying that every `spin complete` and gate transition produces the correct `run.json` state.

### Run locally

```bash
npm test
```

### CI

Add to your pipeline:

```yaml
- run: npm ci
- run: npm test
```

No model credentials needed — all tests are deterministic. The no-model-calls guard checks source for known inference imports and network-call patterns.

### Gating a project that uses spindle

Everything above is spindle testing itself. A project that *installs*
spindle can run the same `spin gate` / `spin handoff-check` / `spin schema
validate` checks in its own CI, so a feature's gates are re-verified on the
PR, not just claimed inside a chat session. That requires committing the
relevant `.spindle/` state to the branch — see
[`docs/CI_RECIPE.md`](docs/CI_RECIPE.md) for exactly what each check needs
and its honest limits, and [`docs/examples/spindle-gates.yml`](docs/examples/spindle-gates.yml)
for a complete, copy-pasteable workflow.

---

## Proven on itself — the dogfood

Spindle was driven on itself, twice, against a *real* PIX BR Code library (a TS lib that
generates + parses a static PIX copia-e-cola: EMV TLV + CRC16-CCITT). Each phase agent
drove `spin`, parked at the gate, and was *forbidden* from faking a pass (no `--force`, no
hand-edited `run.json`) — honesty enforced mechanically, not by good behavior.

- **Run #1** — the harness held end-to-end (4 honest gates; the library independently
  re-verified by the observer, not trusted from the agent's word). It also produced a *true
  positive against the harness itself*: `G_DEFINE` passed a **factually-wrong** acceptance
  criterion (a CRC value that didn't match the standard), because gates check structure, not
  truth. The build caught it (the criterion was executable) but left the spec false while
  every gate stayed green — a silent spec↔build drift. → fixed with the `corrected_spec` /
  `spin spec-drift` mechanism.
- **Run #2** — the fixes worked (zero source-diving, a real drift flagged + reconciled, not
  shipped silently) and surfaced two more gaps *in the fixes themselves* — both then fixed.

The loop did its job twice: it proved the harness holds, then caught the holes in its own
repair. Full write-up: [`docs/DOGFOOD_LOG_pix-brcode.md`](docs/DOGFOOD_LOG_pix-brcode.md).

---

## Attribution

The typed gates (`G_DEFINE` / `G_DESIGN` / `G_BUILD` / `G_SHIP` / …), the exit-code ABI (`0` pass / `1` block / `2` usage / `3` crash), the handoff sidecar contracts, the model-routing policy, and the hard seam (`spin` never calls a model) are Spindle originals.

Spindle's artifact-graph engine (Kahn ordering, schema validation, cycle detection, CLI build mechanics), its 5-phase SDD workflow shape, specialist agent roster, and knowledge-base domains were adapted from prior open-source work, and the harness-pattern doctrine behind the `adversarial-gate` / `bounded-loop` / `parallel-fanout` / `model-routing` skills traces to outside prior art as well. Full provenance — project names, licenses, and per-file `origin:` stamps — lives in one place: [CREDITS.md](./CREDITS.md).

---

> `spin` is the spine. Claude is the worker. The gate is the judge.
