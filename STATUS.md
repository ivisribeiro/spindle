# STATUS

Version: 0.1.0 (`package.json`). Pre-1.0 — internals may still shift.

## Verified test baseline

`npx vitest run` → **369 tests passing, 39 test files, 0 failing** (measured
directly against this checkout while writing this file — re-run it yourself;
this document is not CI-enforced to stay in sync with the live count).

## What works today

- **28 `spin` CLI subcommands** (`src/cli/index.ts`) — deterministic and
  model-free, enforced by a guard test (`scripts/guard-no-model-calls.js`) that
  fails the build if `src/` references an LLM SDK, `fetch(`, or a
  tokenizer/pricing symbol. `spin explain <gate>` / `spin kinds` / `spin --help`
  surface the closed sets from inside the CLI itself.
- **3 workflow schemas** under `schemas/`: `sdd` (Brainstorm → Define → Design
  → Build → Ship), `kb` (knowledge-base authoring), `brownfield` (audit-first
  bridge into the sdd cycle). Each is editable YAML data, not code.
- **11 gates**, each with a passing AND a blocking fixture replayed by
  `spin eval --strict` — a gate that stops blocking what it used to block is a
  regression CI catches with no model and no network.
- **10 handoff schema ids, 17 worker agents, 30 slash commands, 9 skills, 1 KB
  domain** — see `verification/inventory.json` (regenerated from source by
  `scripts/gen-inventory.js`; `npm run inventory:check` fails the build if any
  hand-written count in the marketplace/plugin manifests drifts from reality).
- **Plugin bundle self-containment** — `npm run build` produces a single
  esbuild bundle (`dist/cli/index.js`, dependencies inlined) and mirrors it
  plus `schemas/` into `plugin/dist/` + `plugin/schemas/`, so the installed
  plugin runs offline with no `node_modules`. `spin verify-self` recomputes
  sha256 over both bundles and every schema file against
  `verification/checksums.json` (also written by `npm run build`).
- **`spin doctor`** — read-only orientation: node version vs `engines.node`,
  active-run health, schema validity, gate verdicts, and the exact next slash
  command to run.

## Known limitations (stated bluntly)

- **Model-reported token usage is trusted, not measured.** `spin trace` /
  `spin budget` only sum the `tokens_in`/`tokens_out` a worker puts on its
  handoff sidecar. The CLI never tokenizes or prices anything, so a wrong or
  omitted number is undetectable from inside the harness.
- **`events[]` is now hash-chained (tamper-evident), but the state maps are
  not.** Every event appended since `src/core/run/event-chain.ts` shipped
  carries a `hash` linking it to the previous hashed event; `spin trace
  --verify` walks the chain and exits 1 naming the first broken link if any
  event's content (or an earlier link) was altered out of band. The residual,
  honest limit: `completed[]`/`gates{}`/`approval` remain plain, Zod-validated
  JSON with no chain over them — a hand-edit confined to those maps (leaving
  `events[]` untouched) is still undetectable.
- **One active run per checkout.** `.spindle/run.json` holds exactly one
  feature; there is no multi-run or workspace concept yet. `spin init` now
  guards against accidental clobbering — it refuses (exit 1) to overwrite a
  run with recorded progress unless `--force` is passed; multi-run is still
  not supported, this only prevents a silent overwrite of the single active one.
- **`G_PLAN`'s falsifiability check is heuristic English parsing** — it looks
  for a file-path- or command-shaped token in a task's `detail` string. A task
  description that merely mentions a path without acting on it can slip past.
- **`spin pack add` is promised in `packs/README.md` but not implemented.**
  Moving a specialist from `packs/` back into `plugin/` today is a manual
  `git mv` followed by `spin gate G_ROUTER_COVERAGE`, not a CLI command.
- **Gates certify structure and identity, not truth.** A gate can prove a file
  exists, a criterion is `passed`, a verifier is cited, and criteria sets are
  consistent — it cannot prove a value is correct or a prose claim is true.
  See the README's "Honest limit" note and `docs/DOGFOOD_LOG_pix-brcode.md`.
- **`spin verify-self` trusts the manifest's own file list.** It re-hashes
  exactly what `verification/checksums.json` names; it does not independently
  re-enumerate `schemas/`/`plugin/schemas/`, so a file added after the last
  build without ever being recorded is not flagged as unexpected.

## Deferred

- An append-only event hash chain for `run.json` tamper-evidence.
- `spin pack add` to automate moving a `packs/` specialist back into `plugin/`.
- Multi-run / multi-feature support inside a single `.spindle/` checkout.
- Independent verification of model-reported token usage — would require an
  actual tokenizer/pricing dependency, which the model-free guard on `src/`
  deliberately forbids today.
