# brownfield-audit

The capability that lets Spindle model **audit-then-plan** on an existing, messy
project — not just greenfield `define → design → build`. Added as improvements
I1–I5, I7, I9 after dogfooding the planning of a real codebase.

## The audit handoff
A typed contract (`audit` handoff id) carrying:
- `built[]` — `{ evidence: { files, proof }, status: proven|partial|scaffolded, resolved_at_commit, verified_in_code }`
- `gaps[]` — `{ capability, why, priority: blocking|important|nice-to-have }`
- `weakPoints[]`, `opsReadiness[]`, `proposedTasks[]` (with `external_preconditions`/`domains`), `invariants_at_risk[]`

Driven by a separate `brownfield` schema (`audit → define → design`) so the
greenfield `sdd` cycle is untouched, and by the `/audit` command (parallel fan-out
by domain).

## The new gates
- **G_AUDIT** — blocks an empty audit, a built item without evidence, or a gap
  without a priority.
- **G_OPS_CONFIG** — blocks any `opsReadiness` item with `enforced: false`: a flag
  coded but inert in prod (the "RLS is on but the DB role bypasses it" class). This
  class is invisible to code review and static analysis.
- **G_PLAN** — blocks a vague-acceptance task, an L/XL task bundling >1 domain, or
  a `blocking` gap addressed by no task.

## Companion commands
- `spin reconcile --audit f.json` — doc-vs-code drift (exit 1 on inconsistent items).
- `spin config-drift --declared a,b --present a` — a tool used in CI but absent
  from the lockfile.
