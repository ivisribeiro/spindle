---
name: audit
description: Brownfield audit command — init a brownfield run, fan out one auditor worker per domain (parallel-fanout), validate each audit handoff sidecar, run G_AUDIT, then recommend G_OPS_CONFIG + G_PLAN before /define.
---

# /audit

Phase 0 of the **brownfield** workflow. Inventories an existing codebase domain by
domain: what is already built (with file+line evidence), the gaps, the weak points,
and the ops-readiness controls. Every claim must be evidence-backed — G_AUDIT
makes that a hard gate, not a prose aspiration.

The `spin` shorthand below means: `node ${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js <args>`.

---

## Step 1 — scaffold the brownfield run

If no `.spindle/` directory exists in the working tree yet:

```bash
spin init --schema brownfield --feature <name>
```

`<name>` is the slug for the codebase or subsystem under audit (e.g. `auth-service`,
`payments-core`, `erin-ingest`). This creates `.spindle/schema.yaml` (pointing at
the bundled brownfield schema) and the feature directory tree.

**Exit 1 — active-run conflict:** `spin init` refuses to clobber a run that already
has recorded progress (one active run per checkout). Surface the `reason` (it names
the active schema + feature) to the human and STOP. Do **not** pass `--force`
yourself — overwriting an in-progress run is a human decision, never an autonomous
one. Tell the user to either finish/abandon the active run themselves, or re-run
`/audit` with `spin init --force` by their own hand.

If `.spindle/` already exists, skip this step. Confirm the schema is brownfield:

```bash
spin state
```

Parse the JSON: check that `schema` equals `brownfield`. If it is `sdd` or `kb`,
you are in the wrong workflow — stop and tell the user to run `spin init --schema
brownfield --feature <name>`.

---

## Step 2 — read the domain config (optional but recommended)

Check whether `.spindle/audit-domains.yaml` exists. This file declares the bounded
scope for each auditor worker (see the reference file at
`schemas/brownfield/audit-domains.yaml`):

```yaml
# .spindle/audit-domains.yaml
domains:
  - domain: auth
    file_globs:
      - "src/auth/**"
      - "src/middleware/auth*.ts"
    max_files: 40
  - domain: api
    file_globs:
      - "src/api/**"
      - "src/routes/**"
    max_files: 60
```

If the file is absent, derive the domain list from the codebase structure yourself
(top-level modules / packages / bounded contexts). Cap each worker at
`max_files: 50` unless the config overrides it. A worker that receives too many
files will skim the last ones — the cap is what makes the fan-out safe.

---

## Step 3 — route the auditor workers

Run `spin route` for each kind you will dispatch. Audit workers are critical
analysis tasks and use two tiers:

```bash
spin route finding-analysis   # -> sonnet (per-domain auditor workers)
spin route adversary           # -> opus   (optional adversarial challenger)
```

Each per-domain auditor runs at the `finding-analysis` tier (sonnet). Do not
downgrade: `finding-analysis` has `floor: sonnet` and is never downgradable.

---

## Step 4 — fan out one auditor worker per domain (single message)

This step follows the **parallel-fanout** skill. Dispatch ALL domain workers in a
**single Task message** — one Task call per domain, all in the same message.

Each **auditor-worker** receives:
- The domain name and the resolved file list (apply `file_globs` + `max_files`)
- The path to `.spindle/schema.yaml` (for feature context and policy)
- Its output targets (AUDIT.md fragment + handoff sidecar path)

**Auditor-worker instructions (one per domain, run in parallel):**

> You are the auditor for the **{domain}** domain. Your file scope is:
> {resolved file list — at most max_files entries}
>
> Read each file. For every claim you make about what is "built", you MUST name
> at least one file with a line reference and a one-line proof string. A claim
> without evidence is not admissible.
>
> Write your output to:
> `.spindle/features/<feature>/.handoffs/audit-{domain}.json`
>
> The sidecar MUST match the `audit` handoff schema exactly:
> ```json
> {
>   "domain": "{domain}",
>   "built": [
>     {
>       "item": "JWT validation",
>       "evidence": {
>         "files": ["src/auth/jwt.ts"],
>         "lines": "42-67",
>         "proof": "verifyToken() calls jwt.verify() with RS256 and checks exp"
>       },
>       "status": "proven",
>       "resolved_at_commit": null,
>       "verified_in_code": true
>     }
>   ],
>   "gaps": [
>     {
>       "capability": "token revocation",
>       "why": "no blocklist or short-TTL enforcement found",
>       "priority": "blocking"
>     }
>   ],
>   "weakPoints": [
>     {
>       "item": "admin bypass via role header",
>       "severity": "critical",
>       "evidence": "src/middleware/auth.ts:L18 — X-Admin header checked before JWT"
>     }
>   ],
>   "opsReadiness": [
>     {
>       "control": "ALLOW_LEGACY_PLAINTEXT",
>       "code_default": "true",
>       "prod_value_required": "false",
>       "env_files_checked": ["deploy/.env.prod"],
>       "enforced": false
>     }
>   ],
>   "proposedTasks": [
>     {
>       "title": "Implement token revocation blocklist",
>       "detail": "Add Redis blocklist checked in verifyToken(); TTL = token exp.",
>       "effort": "M",
>       "dependsOn": null,
>       "external_preconditions": [],
>       "domains": ["auth"]
>     }
>   ],
>   "invariants_at_risk": ["auth idempotency under concurrent requests"],
>   "test_tiers": {
>     "unit": "vitest src/auth/**",
>     "infra_bound": "playwright e2e — requires running Redis"
>   }
> }
> ```
>
> `priority` must be one of `blocking`, `important`, or `nice-to-have`.
> `status` must be one of `proven`, `partial`, or `scaffolded`.
> Every `built[]` item with no evidence files will cause G_AUDIT to block.

Fan out all domain workers at once — do not sequence them. Per the parallel-fanout
skill: independent domains share the same `parallel_group`; dispatch them all in
one message.

---

## Step 5 — validate each domain handoff

After all workers finish, validate each sidecar. Do this independently for each
domain (a failure on one domain does not abort the others):

```bash
spin handoff-check audit .spindle/features/<feature>/.handoffs/audit-{domain}.json
```

If exit code is `1` (schema invalid), enter the bounded fix loop for that domain:

```bash
spin retry audit --inc
```

- Exit `0` → re-dispatch that domain's auditor worker (return to Step 4 for this domain).
- Exit `1` (ceiling reached) → call `spin retry audit --ok`, surface the errors to
  the user, and continue with the remaining domains.

---

## Step 6 — mark audit complete with the primary handoff

Once all domain sidecars are valid, mark the `audit` artifact complete. Pass the
sidecar for the first (or primary) domain, or a merged sidecar if you combined them:

```bash
spin complete audit --handoff .spindle/features/<feature>/.handoffs/audit-{domain}.json
```

If multiple domain sidecars exist, merge them into a single
`.spindle/features/<feature>/.handoffs/audit.json` before calling `spin complete`.
The merge is deterministic: concatenate `built[]`, `gaps[]`, `weakPoints[]`,
`opsReadiness[]`, `proposedTasks[]`, and `invariants_at_risk[]` across all domains;
set `domain` to the feature slug.

---

## Step 7 — run G_AUDIT

```bash
spin gate G_AUDIT
```

**exit 1 — BLOCKED:** G_AUDIT blocks when:
- Any `built[]` item has no evidence files.
- Any `built[]` item has an empty proof string.
- Any `gaps[]` item has an invalid or missing priority.
- The audit has zero built items AND zero gaps (empty audit).

Surface `reasons` and `unmet` to the user. Do **not** advance to `/define`. The
user must edit the handoff sidecar (add evidence, add priority, add content) and
re-run from Step 6.

**exit 0 — PASS:** Proceed to Step 8.

---

## Step 8 — recommend next gates and /define

Inform the user:

> G_AUDIT passed. The audit handoff is evidence-backed and gap-prioritized.
>
> Recommended next checks before /define:
>
> ```bash
> spin gate G_OPS_CONFIG   # blocks if any opsReadiness item has enforced=false
> spin gate G_PLAN         # blocks if blocking gaps have no proposedTask, or tasks are too coarse
> ```
>
> Run **/define** when both gates are green (or when you have reviewed and
> accepted any warnings). /define will read the `proposedTasks[]` bridge from the
> audit handoff to seed the acceptance criteria.

---

## Workflow map

```
/audit  →  G_AUDIT  →  G_OPS_CONFIG  →  G_PLAN  →  /define  →  /design  →  /build  →  /ship
           (evidence    (flags off       (tasks
            backed)      in prod)         not coarse)
```

Compare with the greenfield path (which starts at `/define`): the audit phase
exists only in the `brownfield` schema.

---

## Constraints

- **Never invent gate ids or handoff ids.** Only `G_AUDIT`, `G_OPS_CONFIG`, and
  `G_PLAN` are referenced here — all exist in the live gate registry. The handoff
  id is `audit` — it exists in the live handoff registry.
- **Never dispatch workers outside a Task call.** Auditor workers are always
  dispatched via the Task tool inside this slash command.
- **Never advance to `/define` before `G_AUDIT` exits 0.** A blocked gate is
  always a hard stop.
- **`spin route` before every worker dispatch.** Do not hardcode model names.
