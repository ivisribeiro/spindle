# CI recipe: gating a project that USES spindle

Spindle gates itself — `.github/workflows/ci.yml` in this repo runs the guard
tests, the eval corpus, and the inventory check on every push. That proves the
harness holds *inside spindle's own checkout*. It says nothing about a
project that *installs* spindle to drive its own feature work.

This doc is the other half: how a downstream project wires `spin gate` /
`spin handoff-check` / `spin schema validate` into **its own** GitHub Actions,
so "did this feature actually pass its gates" is a property of the repository
and the PR, not just a claim made inside a chat session that nobody can
re-check after the fact.

Nothing here is aspirational — every `spin` invocation below was run against
a real fixture while writing this doc (see the checked-in
[`spindle-gates.yml`](examples/spindle-gates.yml) for the runnable version).
Every subcommand used in (a), (b), and (d) is part of the closed CLI surface
documented in this repo's `CLAUDE.md` §4. `spin verify-self` in (c) is a real,
shipped, tested subcommand (`src/cli/index.ts`, `src/core/verify-self.ts`) —
CLAUDE.md §4's table simply hasn't been updated to list it yet, alongside
`spin doctor`. Worth fixing there; not something this doc can silently paper
over.

---

## The one thing that trips people up: state has to be committed

`spin` is a deterministic reader of `.spindle/` on disk. In *this* repo,
`.spindle/` is gitignored — spindle's own dev loop treats it as scratch state
for whichever feature is active locally. **For CI in a downstream project to
mean anything, that has to invert**: the project must deliberately commit
the `.spindle/` state (or the specific files a check needs) for the feature
whose gates it wants enforced in the PR. If `.spindle/` is gitignored the way
spindle gitignores its own, every check below either no-ops or fails to find
its inputs — not because spin is broken, but because there is nothing on disk
for it to read.

Each check needs a different amount of that state:

| Check | Reads | Needs committed to the repo |
|---|---|---|
| `spin schema validate` | `.spindle/schema.yaml` | The schema file. Small, changes rarely, exists for any project that has run `spin init` at least once. |
| `spin handoff-check <id> <file>` | exactly the one file you pass | Just that sidecar. No `.spindle/run.json`, no ledger — this check never touches run state at all. |
| `spin gate G_BUILD` | `.spindle/run.json`, `.spindle/schema.yaml`, `.spindle/features/<feature>/.handoffs/{define,design,build}.json`, `BUILD_REPORT.md`, **and every file the design manifest names, cross-checked against the real working tree** | The **full** `.spindle/` tree for that feature. G_BUILD isn't a spindle-internal check — it verifies your actual source files exist at the paths the design manifest promised. |
| `spin verify-self` | `dist/cli/index.js` and/or `plugin/dist/cli/index.js`, `schemas/**`/`plugin/schemas/**`, `verification/checksums.json` | Only relevant if *you* vendor a full copy of spindle's build output into your repo (see §(c) below) — most projects will never commit these paths. |
| `spin eval --strict --corpus <dir>` | your own corpus directory of `case.json` fixtures | The corpus directory itself, checked in wherever you keep it. |

If a row's "needs committed" column doesn't hold for your project, skip that
check — don't fake the inputs to make it pass.

---

## (a) Structural checks: `schema validate` + `handoff-check` — cheap, always available

These two never touch a live run's ledger (`schema validate` needs
`.spindle/schema.yaml`; `handoff-check` needs nothing but the file you name),
so they're the cheapest thing to run on every PR regardless of what phase a
feature is in. They catch two different failure modes: a hand-edited
`schema.yaml` that's no longer well-formed, and a hand-edited (or
hallucinated) handoff sidecar that no longer matches its schema.

```yaml
# .github/workflows/spindle-gates.yml (excerpt) — see docs/examples/spindle-gates.yml
# for the full, runnable file.
- name: spin schema validate
  run: node "$SPIN_CLI" --root "$GITHUB_WORKSPACE" schema validate

- name: spin handoff-check (every committed sidecar)
  run: |
    set -euo pipefail
    shopt -s globstar nullglob
    # Ask spin itself which handoff schema id each artifact expects — don't
    # hardcode the artifact-id -> handoff-id mapping, it's schema.yaml's data.
    declare -A HANDOFF_FOR
    while IFS=$'\t' read -r artifactId handoffId; do
      HANDOFF_FOR["$artifactId"]="$handoffId"
    done < <(node "$SPIN_CLI" --root "$GITHUB_WORKSPACE" schema show \
              | jq -r '.artifacts[] | select(.handoff) | [.id, .handoff] | @tsv')

    status=0
    for sidecar in .spindle/features/**/.handoffs/*.json; do
      artifactId=$(basename "$sidecar" .json)
      handoffId="${HANDOFF_FOR[$artifactId]:-}"
      [ -z "$handoffId" ] && { echo "::warning::no handoff id for $sidecar, skipping"; continue; }
      node "$SPIN_CLI" handoff-check "$handoffId" "$sidecar" || status=1
    done
    exit $status
```

Note the mapping step: the sidecar file is named after the *artifact*
(`.handoffs/build.json`), but the schema id you pass to `handoff-check` is
the artifact's declared `handoff:` field (`build-report` for the `build`
artifact, per `schemas/sdd/schema.yaml`) — those two are not always the same
string. Reading it from `spin schema show` rather than hardcoding it means
this loop keeps working if a project forks the schema and renames things.

`handoff-check` exits `1` (not `2`) on a schema mismatch — that's a domain
block, not a CLI usage error, so a failing sidecar fails the job the same way
a failing test would.

---

## (b) `spin gate G_BUILD` on feature branches — the seam applied to merges

This is the check with teeth: it re-runs the exact same gate `/build` and
`/ship` run locally, against whatever `.spindle/` state the PR branch
committed, and fails the CI job on exit `1`. A PR cannot merge a feature that
spindle itself considers unbuilt — the ordering/validation/gate decision that
`/build` made locally gets *re-verified*, not re-trusted, on someone else's
machine (the CI runner).

```yaml
# .github/workflows/spindle-gates.yml (excerpt)
- name: spin gate G_BUILD
  run: node "$SPIN_CLI" --root "$GITHUB_WORKSPACE" gate G_BUILD
```

That's the whole check — no flags, because `G_BUILD` reads everything it
needs from the committed `.spindle/` tree plus the working directory (the
manifest-file-existence check walks the real repo, not `.spindle/`). A block
prints `{gate, passed:false, reasons[], unmet[]}` to stdout and the job fails
with exit `1` — read `reasons`/`unmet` in the job log, don't re-run it hoping
it passes.

Two honest caveats, stated plainly:

- **If a repo doesn't commit `.spindle/` for a feature, this check has
  nothing to read.** Guard the step so it skips gracefully instead of failing
  on missing state that was never meant to exist yet — the full example
  workflow does this with a small "does `.spindle/run.json` exist" step
  whose output gates the `gate G_BUILD` step.
- **`G_SHIP`'s human-approval requirement cannot be satisfied *by* CI.**
  `spin approve` refuses a non-interactive stdin by design (CLAUDE.md §4) —
  a GitHub Actions runner has no TTY, so it can never call `spin approve` on
  a repo's behalf. If you also want to gate `G_SHIP` in CI, it can only ever
  *read* an approval a human already recorded and committed locally before
  pushing — CI verifies the sign-off exists, it can't manufacture one.

---

## (c) `spin verify-self` — only if you vendor spindle's dist

`spin verify-self` recomputes sha256 over `dist/cli/index.js` /
`plugin/dist/cli/index.js` and every `schemas/**`/`plugin/schemas/**` file,
and compares against `verification/checksums.json`. That manifest is written
by spindle's own `npm run build` — it is **not** something a downstream
project generates for its own code. This check is only meaningful if your
project **vendors** a full copy of spindle's build output (the esbuild
bundle plus the schema tree plus the checksum manifest) directly into your
repo, rather than pulling `dist/cli/index.js` fresh from a pinned checkout on
every run (which is what the example workflow in this doc actually does, for
exactly this reason — a live checkout of a pinned tag doesn't need this
check, because there's no vendored copy that could silently drift).

If you do vendor a copy — e.g. because your CI environment can't reach
GitHub to check out a second repo — run it once, after vendoring, to catch
tampering:

```yaml
- name: spin verify-self (only if you vendor dist/ + schemas/ into this repo)
  run: node ./vendor/spindle/dist/cli/index.js --root ./vendor/spindle verify-self
```

Exit codes here diverge slightly from the checksum-mismatch case you'd guess:
`0` clean, `1` mismatched or missing files, `2` if `verification/checksums.json`
itself is absent (a usage error — you vendored the bundles but forgot the
manifest, or ran the wrong `--manifest` path).

---

## (d) `spin eval --strict` — for a project with its own eval corpus

If your project relies on a specific gate *configuration* (`build_retry_cap`,
`require_verified_by`, etc. in `schema.yaml`) and you want a change to that
config — or a spindle upgrade — to be caught the moment it changes gate
behavior, maintain your own eval corpus the same shape as
[`schemas/evals/`](../schemas/evals) in this repo: one directory per case,
each with a `case.json` naming the gate, the expected verdict, and either
`args` (for arg-file gates like `G_REVIEW_BLOCK`) or a `.spindle/` fixture
tree (for state-coupled gates like `G_BUILD`) sitting inside the case
directory.

```yaml
- name: spin eval --strict (your own gate-config regression corpus)
  run: node "$SPIN_CLI" eval --corpus ./ci/spindle-eval-corpus --strict
```

`--strict` fails the job if *any* recorded case's verdict no longer matches
(a real regression) **or** if the corpus doesn't have both a pass and a block
case for every gate in the registry (fail-closed completeness — see
`schemas/evals/README.md` in this repo for the exact rule). Don't reach for
this unless you actually maintain the fixtures; an empty or stale corpus
passing `eval` proves nothing.

---

## What CI should never do

CI's job here is **re-verification of state a human or an agent session
already produced**, never advancing the run itself. Concretely, never call
these from a CI job: `spin init`, `spin complete`, `spin approve`,
`spin invalidate`, `spin retry --inc`. Every one of those mutates
`.spindle/run.json`, and a CI runner mutating a ledger that the PR branch
didn't commit back is worse than not gating at all — it produces a green
check that doesn't correspond to anything reproducible from the diff. If a
gate blocks, the fix is to re-run `/build` (or whichever phase) locally and
push the corrected `.spindle/` state — not to make the CI job "pass" by
having it complete the work itself.

## Honest limits

Everything above inherits spindle's own stated limits — read them before you
wire this in and treat a green gate accordingly:

- **Gates certify structure and identity, not truth.** `G_BUILD` proves a
  file exists, criteria-set match, and (if `require_verified_by` is on) a
  verifier is cited — it cannot prove the verifier's *result* is correct,
  only that a CI-produced result exists and isn't `failed`. See the
  README's "Honest limit" callout and `docs/DOGFOOD_LOG_pix-brcode.md` for a
  real case where every gate passed and the spec was still factually wrong.
- **Model-reported token usage is trusted, not measured** — if you extend
  `spin budget`/`spin trace` into a CI cost report, remember the CLI never
  tokenizes or prices anything; a worker that misreports `tokens_in`/
  `tokens_out` on its handoff is undetectable from inside the harness.
- **`spin verify-self` trusts the manifest's own file list** — it re-hashes
  exactly what `verification/checksums.json` names; it does not
  independently re-enumerate the schema tree, so a file added without ever
  being recorded in the manifest is not flagged as unexpected.

See [`STATUS.md`](../STATUS.md) for the complete, current list of known
limitations, and [`README.md`](../README.md#test-and-ci-story) for how
spindle gates itself.

## See also

- [`docs/examples/spindle-gates.yml`](examples/spindle-gates.yml) — the
  complete, copy-pasteable workflow implementing (a) + (b).
- [`STATUS.md`](../STATUS.md) — verified test baseline and known limitations.
- [`docs/MEASUREMENT.md`](MEASUREMENT.md) — the run-ledger / eval / budget
  doctrine, if you want to go further than a pass/fail gate in CI.
