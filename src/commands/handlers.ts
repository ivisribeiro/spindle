import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactGraph } from '../core/artifact-graph/graph.js';
import { loadSchema } from '../core/artifact-graph/schema.js';
import { validateSchemaContent } from '../core/artifact-graph/schema-validate.js';
import { detectCompleted } from '../core/artifact-graph/state.js';
import { artifactOutputExists } from '../core/artifact-graph/outputs.js';
import {
  initRunState,
  loadRunState,
  markComplete,
  markApproved,
  markIncomplete,
  invalidate,
  completedSet,
  incRetry,
  getRetry,
  recordGate,
  runStateExists,
  featureDir,
  handoffDir,
  schemaCopyPath,
  atomicWrite,
} from '../core/run/run-state.js';
import { Usage, type RunEvent } from '../core/run/run-state.schema.js';
import { buildGateContext, runGate } from '../core/gates/gate-runner.js';
import { checkHandoffFile, checkHandoffObject } from '../core/handoff/handoff-check.js';
import { criteriaDiff } from '../core/validation/criteria-diff.js';
import {
  validateSections,
  hasManifestTable,
  extractCriteriaIds,
  findDanglingReferences,
  findInvalidUrls,
} from '../core/validation/md-section-validator.js';
import { computeDefineCoverage } from '../core/validation/define-coverage.js';
import { route, listTaskKinds, type Budget } from '../core/model-route/policy.js';
import { classifyTier, type TierSignals, type Risk, type Breadth } from '../core/model-route/tiers.js';
import { aggregateUsageStats } from '../core/model-route/usage-stats.js';
import { verifyEventChain } from '../core/run/event-chain.js';
import { captureApprovalSnapshot } from '../core/run/approval-snapshot.js';
import { reconcileAudit } from '../core/reconcile.js';
import { configDrift } from '../core/config-drift.js';
import { explainGate } from '../core/gates/gate-docs.js';
import { listGates, isGateId } from '../core/gates/registry.js';
import { DesignHandoff } from '../core/handoff/schemas.js';
import {
  compareManifestToSidecars,
  readBuildTaskSidecarRefs,
} from '../core/fanout/file-fanout.js';
import { describeHandoff, listHandoffIds } from '../core/handoff/describe.js';
import { isSafeSlug } from '../core/util/paths.js';
import { specDrift, type BuildResult } from '../core/spec-drift.js';
import { runEvalCorpus } from '../core/eval/eval.js';
import { runDoctor } from '../core/doctor/doctor.js';
import { verifySelf } from '../core/verify-self.js';

// Each handler returns a HandlerResult; the CLI prints `json` and exits `code`.
// Exit-code ABI: 0 pass · 1 gate-blocked/invalid · 2 usage · 3 internal.
export interface HandlerResult {
  code: 0 | 1 | 2 | 3;
  json: unknown;
}

function ok(json: unknown): HandlerResult {
  return { code: 0, json };
}
function blocked(json: unknown): HandlerResult {
  return { code: 1, json };
}
function usage(message: string): HandlerResult {
  return { code: 2, json: { error: message } };
}

/** Locate the package root (where bundled schemas/ live), from src/ or dist/. */
function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function bundledSchemaPath(name: string): string {
  return path.join(packageRoot(), 'schemas', name, 'schema.yaml');
}

function activeGraph(root: string): ArtifactGraph {
  return ArtifactGraph.fromYaml(schemaCopyPath(root));
}

/** Completion = run-state ledger UNION filesystem detection (crash-safe). */

/** True when the existing ledger has recorded any actual work — completions, gate
 *  verdicts, ledger events, or a human approval. A run that was merely `spin init`'d
 *  (a fresh, empty ledger) is "pristine" and safe to re-init without --force. */
function runHasProgress(state: import('../core/run/run-state.schema.js').RunState): boolean {
  return (
    state.completed.length > 0 ||
    state.events.length > 0 ||
    Object.keys(state.gates).length > 0 ||
    state.approval !== null
  );
}

export function initHandler(
  root: string,
  opts: { schema?: string; feature?: string; force?: boolean }
): HandlerResult {
  const schemaName = opts.schema ?? 'sdd';
  const feature = opts.feature ?? 'feature';
  // The feature slug becomes a directory name and a trusted run-state value — reject
  // anything that isn't a plain kebab-case slug so it can't escape `.spindle/features/`.
  if (!isSafeSlug(feature)) {
    return usage(`--feature must be a kebab-case slug [a-z0-9-] (got "${feature}")`);
  }
  const src = bundledSchemaPath(schemaName);
  if (!fs.existsSync(src)) {
    return usage(`unknown bundled schema "${schemaName}" (expected schemas/${schemaName}/schema.yaml)`);
  }

  // One active run per checkout (§8 doctrine): refuse to silently clobber a run that
  // has actual progress recorded. `--force` is the only way past this, and it is a
  // human decision — a command must never pass it autonomously (see plugin/commands
  // notes on the /audit, /sync-context, /create-kb init steps).
  if (!opts.force && runStateExists(root)) {
    const existing = loadRunState(root);
    if (runHasProgress(existing)) {
      return blocked({
        initialized: false,
        reason:
          `an in-progress run already exists — schema "${existing.schema}", feature "${existing.feature}" ` +
          `(completed=${existing.completed.length}, events=${existing.events.length}, ` +
          `gates=${Object.keys(existing.gates).length}, approved=${existing.approval !== null}). ` +
          `Refusing to clobber it.`,
        active: { schema: existing.schema, feature: existing.feature },
        escape_hatch:
          'pass --force to overwrite the active run anyway — this is a human decision; ' +
          'an automated agent must not pass --force on its own',
      });
    }
    // Pristine run (initialized, zero progress) — safe to re-init freely, no --force needed.
  }

  // Validate the bundled schema before copying.
  try {
    loadSchema(src);
  } catch (e) {
    return { code: 3, json: { error: `bundled schema invalid: ${(e as Error).message}` } };
  }
  fs.mkdirSync(featureDir(root, feature), { recursive: true });
  fs.mkdirSync(handoffDir(root, feature), { recursive: true });
  fs.copyFileSync(src, schemaCopyPath(root));
  const state = initRunState(root, schemaName, feature);
  return ok({ initialized: true, schema: schemaName, feature, runState: state, forced: opts.force === true });
}

export function stateHandler(root: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  return ok(loadRunState(root));
}

export function traceHandler(root: string, opts: { verify?: boolean } = {}): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const state = loadRunState(root);
  const events = state.events;

  const completes = events.filter(
    (e): e is Extract<RunEvent, { kind: 'complete' }> => e.kind === 'complete'
  );
  const gates = events.filter((e): e is Extract<RunEvent, { kind: 'gate' }> => e.kind === 'gate');
  const retries = events.filter((e) => e.kind === 'retry');

  // Pure aggregation over RECORDED events: counting completions/verdicts and summing
  // model-reported token numbers. No tokenization, no pricing — the spine never
  // measures inference, it only adds up numbers the model handed it.
  const tierHistogram: Record<string, number> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  let anyTokensReported = false;
  for (const c of completes) {
    const tier = c.usage?.tier ?? 'unreported';
    tierHistogram[tier] = (tierHistogram[tier] ?? 0) + 1;
    if (c.usage?.tokens_in != null) {
      tokensIn += c.usage.tokens_in;
      anyTokensReported = true;
    }
    if (c.usage?.tokens_out != null) {
      tokensOut += c.usage.tokens_out;
      anyTokensReported = true;
    }
  }

  const base = {
    feature: state.feature,
    schema: state.schema,
    events,
    summary: {
      completed: completes.length,
      gates: {
        total: gates.length,
        passed: gates.filter((g) => g.passed).length,
        blocked: gates.filter((g) => !g.passed).length,
      },
      retries: retries.length,
      tier_histogram: tierHistogram,
      // null (not zero) when no worker reported usage — absence is honest, since the
      // CLI cannot derive these itself.
      reported_tokens: anyTokensReported ? { tokens_in: tokensIn, tokens_out: tokensOut } : null,
    },
  };

  // Plain `spin trace` stays a pure read (exit 0, no `chain` key) — unchanged from
  // before this feature. `--verify` additionally walks the events[] hash chain
  // (event-chain.ts): exit 0 with `{chain:{verified,legacy}}` when intact, exit 1
  // naming the first broken link when a hashed event's content (or an earlier
  // link) was altered out of band.
  if (!opts.verify) return ok(base);

  const verification = verifyEventChain(events);
  if (verification.ok) {
    return ok({ ...base, chain: { verified: verification.verified, legacy: verification.legacy } });
  }
  return blocked({
    ...base,
    chain: {
      verified: verification.verified,
      legacy: verification.legacy,
      broken_at: verification.brokenAt,
      reason: verification.reason,
    },
  });
}

export function budgetHandler(
  root: string,
  opts: { maxTokens?: string; enforce?: boolean }
): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  let flagMax: number | null = null;
  if (opts.maxTokens !== undefined) {
    const n = Number(opts.maxTokens);
    if (!Number.isFinite(n) || n < 0) return usage('--max-tokens must be a non-negative number');
    flagMax = Math.floor(n);
  }

  const state = loadRunState(root);
  const completes = state.events.filter(
    (e): e is Extract<RunEvent, { kind: 'complete' }> => e.kind === 'complete'
  );

  // Reconcile reported spend per tier. The CLI only SUMS numbers the model handed it
  // on the handoff sidecar — it never tokenizes, estimates, or prices. This is
  // accounting, not enforcement (unless --enforce opts in below): it cannot
  // independently verify a self-reported count.
  const byTier: Record<string, { completions: number; tokens_in: number; tokens_out: number }> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  let anyReported = false;
  for (const c of completes) {
    const tier = c.usage?.tier ?? 'unreported';
    const bucket = (byTier[tier] ??= { completions: 0, tokens_in: 0, tokens_out: 0 });
    bucket.completions += 1;
    if (c.usage?.tokens_in != null) {
      bucket.tokens_in += c.usage.tokens_in;
      tokensIn += c.usage.tokens_in;
      anyReported = true;
    }
    if (c.usage?.tokens_out != null) {
      bucket.tokens_out += c.usage.tokens_out;
      tokensOut += c.usage.tokens_out;
      anyReported = true;
    }
  }
  const total = tokensIn + tokensOut;

  if (!opts.enforce) {
    // ADVISORY by design (unchanged, byte-identical to pre-`--enforce` behavior):
    // always exit 0. A genuinely T2 task SHOULD cost a lot; plain `spin budget` must
    // never block legitimate spend. The signal is the `over_budget` flag + warning,
    // not an exit code.
    const overBudget = flagMax != null && anyReported && total > flagMax;
    return ok({
      feature: state.feature,
      reported: anyReported ? { tokens_in: tokensIn, tokens_out: tokensOut, total } : null,
      by_tier: byTier,
      max_tokens: flagMax,
      over_budget: overBudget,
      advisory: true,
      warning: overBudget
        ? `reported spend ${total} tokens exceeds the declared budget of ${flagMax} — advisory only, not enforced`
        : null,
    });
  }

  // --enforce: opt-in ceiling. Precedence: --max-tokens flag, else config.max_tokens
  // from the active schema. Enforcing with no ceiling anywhere is a malformed
  // request (exit 2), not a domain block.
  let ceiling = flagMax;
  let ceilingSource: 'flag' | 'config' | null = flagMax != null ? 'flag' : null;
  if (ceiling == null) {
    const configMax = activeGraph(root).getSchema().config?.max_tokens ?? null;
    if (configMax != null) {
      ceiling = configMax;
      ceilingSource = 'config';
    }
  }
  if (ceiling == null) {
    return usage(
      '--enforce requires a ceiling — pass --max-tokens <n> or set config.max_tokens in the active schema'
    );
  }

  const overBudget = anyReported && total > ceiling;
  // `self_reported: true` keeps the honest-accounting doctrine visible even under
  // enforcement — these numbers are still model-reported, never measured, so a
  // block here is a policy decision on trust, not a proven overage.
  const result = {
    feature: state.feature,
    reported: anyReported ? { tokens_in: tokensIn, tokens_out: tokensOut, total } : null,
    by_tier: byTier,
    max_tokens: ceiling,
    ceiling_source: ceilingSource,
    over_budget: overBudget,
    advisory: false,
    enforced: true,
    self_reported: true,
    warning: overBudget
      ? `reported spend ${total} tokens exceeds the enforced ceiling of ${ceiling} (self-reported, not measured)`
      : null,
  };
  return overBudget ? blocked(result) : ok(result);
}

export function fanoutCheckHandler(
  root: string,
  opts: { manifest?: string; handoffs?: string } = {}
): HandlerResult {
  // File-level mode (--manifest): the ledger cannot see a dropped PER-FILE build
  // worker — the whole build phase is ONE ledger artifact, so its parallel_group is
  // trivially all-or-nothing. Compare the design manifest against the per-file
  // build-task sidecars instead. Accounting + verdict only: `missing[]` is the
  // re-dispatch list for the orchestrating command; the CLI never dispatches.
  if (opts.handoffs !== undefined && opts.manifest === undefined) {
    return usage('--handoffs requires --manifest (file-level fan-out mode)');
  }
  if (opts.manifest !== undefined) {
    const manifestPath = path.isAbsolute(opts.manifest) ? opts.manifest : path.join(root, opts.manifest);
    if (!fs.existsSync(manifestPath)) return usage(`manifest not found: ${opts.manifest}`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      return usage(`manifest is not valid JSON: ${(e as Error).message}`);
    }
    const design = DesignHandoff.safeParse(raw);
    if (!design.success) {
      return usage(
        `manifest does not match the design handoff schema: ${design.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`
      );
    }

    let dir: string;
    if (opts.handoffs !== undefined) {
      dir = path.isAbsolute(opts.handoffs) ? opts.handoffs : path.join(root, opts.handoffs);
    } else if (runStateExists(root)) {
      dir = handoffDir(root, loadRunState(root).feature);
    } else {
      return usage('no run state to infer the active feature — pass --handoffs <dir>');
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return usage(`handoffs dir not found: ${dir}`);
    }

    const verdict = compareManifestToSidecars(
      design.data.manifest,
      readBuildTaskSidecarRefs(dir)
    );
    const result = {
      mode: 'files',
      feature: design.data.feature,
      manifest: manifestPath,
      handoffs_dir: dir,
      ...verdict,
    };
    return verdict.passed ? ok(result) : blocked(result);
  }

  // Ledger mode (no flags): unchanged — assert no parallel_group in the artifact
  // graph is partially complete against the run-ledger.
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const completed = completedSet(root);

  const groups = new Map<string, string[]>();
  for (const a of graph.getAllArtifacts()) {
    if (a.parallel_group) {
      const members = groups.get(a.parallel_group) ?? [];
      members.push(a.id);
      groups.set(a.parallel_group, members);
    }
  }

  const reasons: string[] = [];
  const unmet: string[] = [];
  const checked: Array<{ group: string; members: number; complete: number }> = [];
  for (const [group, members] of groups) {
    const done = members.filter((m) => completed.has(m));
    checked.push({ group, members: members.length, complete: done.length });
    // A parallel group that is STARTED (>=1 done) but not FINISHED at a phase boundary
    // means a fanned-out worker was dropped — the silent failure parallel-fanout itself
    // could not catch. Run this before the phase gate.
    if (done.length > 0 && done.length < members.length) {
      const missing = members.filter((m) => !completed.has(m));
      reasons.push(
        `parallel group "${group}" is partially complete (${done.length}/${members.length}) — dropped worker(s): ${missing.join(', ')}`
      );
      for (const m of missing) unmet.push(`incomplete-group:${group}:${m}`);
    }
  }

  const result = {
    feature: loadRunState(root).feature,
    groups: checked,
    passed: unmet.length === 0,
    reasons,
    unmet,
  };
  return unmet.length === 0 ? ok(result) : blocked(result);
}

interface RawFinding {
  file: string;
  line?: number | null;
  severity: string;
  rule: string;
  message: string;
  source: string;
}

export function mergeFindingsHandler(root: string, files: string[], opts: { out?: string }): HandlerResult {
  if (!files || files.length === 0) return usage('merge-findings requires one or more finding JSON files');
  const all: RawFinding[] = [];
  for (const f of files) {
    const p = path.isAbsolute(f) ? f : path.join(root, f);
    if (!fs.existsSync(p)) return usage(`finding file not found: ${p}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return usage(`finding file is not valid JSON: ${p}`);
    }
    const arr = Array.isArray(parsed) ? parsed : (parsed as { findings?: unknown }).findings;
    if (!Array.isArray(arr)) return usage(`expected a findings array (or {findings:[...]}) in ${p}`);
    // Fail closed: validate every input item against the finding schema BEFORE merging, so
    // an unknown severity, a missing source, or a malformed entry can't skew dedupe /
    // severity-ranking / source-aggregation. (G_REVIEW_BLOCK re-validates later, but the
    // merge itself must not transform untrusted review output.)
    const check = checkHandoffObject('finding', { findings: arr });
    if (!check.ok) return usage(`invalid findings in ${p}: ${check.errors.join('; ')}`);
    for (const item of (check.data as { findings: RawFinding[] }).findings) all.push(item);
  }
  // Deterministic merge: dedup by (file, line, rule), keep the higher severity on a
  // collision, and aggregate the distinct contributing sources. Replaces the prose merge
  // so a CRITICAL cannot be dropped (and a source forged) by hand before the gate sees it.
  const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
  const byKey = new Map<string, RawFinding>();
  for (const f of all) {
    const key = `${f.file}::${f.line ?? ''}::${f.rule}`;
    const existing = byKey.get(key);
    if (!existing || (rank[f.severity] ?? 0) > (rank[existing.severity] ?? 0)) byKey.set(key, f);
  }
  const findings = [...byKey.values()];
  const sources = [...new Set(all.map((f) => f.source).filter(Boolean))].sort();
  const out = { findings, sources };
  if (opts.out) {
    const p = path.isAbsolute(opts.out) ? opts.out : path.join(root, opts.out);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n');
  }
  return ok({ out: opts.out ?? null, findings, sources, count: findings.length });
}

export function kbInstallHandler(
  root: string,
  domain: string,
  opts: { from?: string; dest?: string }
): HandlerResult {
  if (!domain || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) {
    return usage('kb-install requires a kebab-case <domain>');
  }
  // Source = the workspace where /create-kb authored the domain (default .spindle/features/<domain>).
  const src = opts.from ? path.resolve(root, opts.from) : featureDir(root, domain);
  if (!fs.existsSync(src)) {
    return usage(`KB source not found: ${src} — run /create-kb ${domain} first`);
  }
  // Only a complete, gate-passing flat KB domain may be published. This is a pure file
  // copy (no model); it lands the generated domain where G_ROUTER_COVERAGE --kb resolves it.
  const required = ['index.md', 'quick-reference.md', 'manifest.json'];
  const missing = required.filter((f) => !fs.existsSync(path.join(src, f)));
  const concepts = fs.readdirSync(src).filter((f) => f.startsWith('concept-') && f.endsWith('.md'));
  if (missing.length > 0 || concepts.length === 0) {
    return blocked({
      installed: false,
      domain,
      missing,
      concepts: concepts.length,
      reason: 'source is not a complete flat KB domain — pass G_KB_STRUCTURE + G_KB_COVERAGE first',
    });
  }
  const destRoot = opts.dest ? path.resolve(root, opts.dest) : path.join(root, 'plugin', 'kb');
  const dest = path.join(destRoot, domain);
  fs.mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const f of [...required, ...concepts]) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
    copied.push(f);
  }
  return ok({ installed: true, domain, dest, copied });
}

export function nextHandler(root: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const state = loadRunState(root);
  // Readiness is computed from the LEDGER (authoritative), NOT from file existence. A
  // worker that only wrote the .md without `spin complete` (no validated handoff) must
  // not make downstream artifacts look unlocked. Filesystem detection is surfaced
  // separately as `detected_on_disk` — a crash-recovery signal, never readiness.
  const ledger = completedSet(root);
  const onDisk = detectCompleted(graph, featureDir(root, state.feature));
  const detectedOnDisk = [...onDisk].filter((id) => !ledger.has(id)).sort();

  // Terminal gates (`during` / `before_complete` hooks) are enforced against the run's
  // final artifact and the run-complete flag — otherwise those hooks (kb/brownfield) are
  // inert and a command that forgot to call them would let the run finish unguarded.
  const finalId = graph.getFinalArtifactId();
  const terminal = graph.getTerminalGates();
  const gateUnpassed = (g: string): boolean => state.gates[g]?.passed !== true;

  const ready: Array<{ id: string; model: string | null; parallel_group: string | null }> = [];
  const gateBlocked: Record<string, string[]> = {};
  for (const id of graph.getNextArtifacts(ledger)) {
    // …and an artifact is only truly ready when the lifecycle gate(s) the schema requires
    // before it are recorded green — otherwise it is gate_blocked, not ready. The final
    // artifact additionally carries the terminal gates.
    const required = [
      ...graph.getRequiredGatesBefore(id),
      ...(id === finalId ? terminal : []),
    ];
    const unmetGates = [...new Set(required)].filter(gateUnpassed);
    if (unmetGates.length > 0) {
      gateBlocked[id] = unmetGates;
      continue;
    }
    const a = graph.getArtifact(id)!;
    ready.push({ id, model: a.model ?? null, parallel_group: a.parallel_group ?? null });
  }
  return ok({
    feature: state.feature,
    ready,
    blocked: graph.getBlocked(ledger),
    gate_blocked: gateBlocked,
    detected_on_disk: detectedOnDisk,
    // A run is complete only when every artifact is done AND every terminal gate is green —
    // never report complete:true while a declared `during`/`before_complete` gate is unpassed.
    complete: graph.isComplete(ledger) && terminal.every((g) => !gateUnpassed(g)),
  });
}

export function orderHandler(root: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  return ok({ order: activeGraph(root).getBuildOrder() });
}

export function completeHandler(
  root: string,
  id: string,
  opts: { handoff?: string }
): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const artifact = graph.getArtifact(id);
  if (!artifact) return usage(`unknown artifact "${id}"`);

  // A --handoff passed for an artifact the schema gives no handoff schema is a malformed
  // invocation (exit 2), not a silently-ignored flag: the caller expected a validation
  // that will never run. Fail loudly so the mistake surfaces (dogfood: /brainstorm
  // documented `complete brainstorm --handoff ...` on a handoff-less artifact).
  if (opts.handoff && !artifact.handoff) {
    return usage(
      `artifact "${id}" declares no handoff schema — remove --handoff (it would not be validated)`
    );
  }

  const ledger = loadRunState(root);
  const missingDependencies = artifact.requires.filter(
    (dependency) => !ledger.completed.includes(dependency)
  );
  if (missingDependencies.length > 0) {
    return blocked({
      passed: false,
      artifact: id,
      reasons: missingDependencies.map((dependency) => `required artifact "${dependency}" is incomplete`),
      unmet: missingDependencies,
    });
  }

  // Lifecycle gate enforcement — the seam made hard. An artifact cannot be marked
  // complete until the gate(s) the schema's `gates:` map requires BEFORE it are
  // recorded green in the ledger. The FINAL artifact additionally carries the terminal
  // gates (`during` / `before_complete`), so a run cannot finish while a declared
  // kb/brownfield gate is unpassed. Closes the hole where a command that skipped
  // `spin gate` advanced state unobstructed (the map used to be prose-only).
  const requiredGates = [
    ...graph.getRequiredGatesBefore(id),
    ...(id === graph.getFinalArtifactId() ? graph.getTerminalGates() : []),
  ];
  if (requiredGates.length > 0) {
    const unmet = [...new Set(requiredGates)].filter((g) => ledger.gates[g]?.passed !== true);
    if (unmet.length > 0) {
      return blocked({
        gate: 'lifecycle',
        passed: false,
        artifact: id,
        reasons: unmet.map(
          (g) => `cannot complete "${id}": required gate ${g} has not passed — run \`spin gate ${g}\` first`
        ),
        unmet,
      });
    }
  }

  // A saved green verdict is insufficient if approved files changed outside Iterate.
  if (requiredGates.includes('G_SHIP')) {
    const current = runGate('G_SHIP', buildGateContext(root));
    if (!current.passed) {
      recordGate(root, 'G_SHIP', { passed: false, reasons: current.reasons });
      return blocked(current);
    }
  }

  // Advisory-only (never affects the exit code): unknown top-level keys the handoff's
  // schema silently stripped on parse (e.g. a typo like "files_writen"). Set below when
  // the artifact carries a handoff sidecar; threaded into the exit-0 result at the end.
  let unknownKeys: string[] | undefined;
  let reportedUsage: Usage | undefined;

  if (artifact.handoff) {
    if (!opts.handoff) {
      return usage(`artifact "${id}" requires --handoff <file.json> (schema: ${artifact.handoff})`);
    }
    const check = checkHandoffFile(artifact.handoff, opts.handoff);
    if (!check.ok) {
      return blocked({
        gate: 'G_HANDOFF',
        passed: false,
        artifact: id,
        schema: artifact.handoff,
        errors: check.errors,
      });
    }
    unknownKeys = check.unknown_keys;
    // Read optional reported usage before normalization strips it, including
    // when the input sidecar is already at the canonical path.
    try {
      const raw = JSON.parse(fs.readFileSync(opts.handoff, 'utf-8')) as { usage?: unknown };
      const parsed = Usage.safeParse(raw.usage);
      if (parsed.success) reportedUsage = parsed.data;
    } catch {
      // Usage is advisory. Its absence must not prevent artifact completion.
    }
    // Persist the validated handoff canonically so gates read it deterministically.
    const dest = path.join(handoffDir(root, ledger.feature), `${id}.json`);
    // Atomic write (tmp + rename) so a crash mid-write can't leave a partial handoff
    // that the gates would then read as invalid JSON — matches the run-ledger's writes.
    atomicWrite(dest, JSON.stringify(check.data, null, 2) + '\n');
  } else {
    // Handoff-less artifact: there is no sidecar to validate, so at minimum verify the
    // artifact actually produced its `generates` output on disk. Marking it complete with
    // no BRAINSTORM.md/SHIPPED.md/etc. hands the operator a "done" the spine never earned.
    const outDir = featureDir(root, ledger.feature);
    if (!artifactOutputExists(outDir, artifact.generates)) {
      return blocked({
        gate: 'output',
        passed: false,
        artifact: id,
        reasons: [
          `cannot complete "${id}": expected output not found on disk: ${path.join(outDir, artifact.generates)}`,
        ],
        unmet: [artifact.generates],
      });
    }
  }

  const state = markComplete(root, id, reportedUsage);
  return ok({
    completed: id,
    runState: state,
    ...(unknownKeys && unknownKeys.length > 0 ? { unknown_keys: unknownKeys } : {}),
  });
}

export function validateHandler(root: string, idOrPath: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const state = loadRunState(root);
  const artifact = graph.getArtifact(idOrPath);

  let mdPath: string;
  let validateSpec = artifact?.validate;
  if (artifact) {
    mdPath = path.join(featureDir(root, state.feature), artifact.generates);
  } else {
    mdPath = path.isAbsolute(idOrPath) ? idOrPath : path.join(root, idOrPath);
  }
  if (!fs.existsSync(mdPath)) {
    return blocked({ valid: false, path: mdPath, issues: ['file not found'] });
  }
  const md = fs.readFileSync(mdPath, 'utf-8');
  const issues: string[] = [];

  if (validateSpec?.md_sections) {
    for (const issue of validateSections(md, validateSpec.md_sections)) {
      issues.push(`section "${issue.section}" ${issue.problem}`);
    }
  }
  if (validateSpec?.manifest_table && !hasManifestTable(md)) {
    issues.push('expected a file-manifest table, none found');
  }
  if (validateSpec?.criteria_ids_prefix) {
    const ids = extractCriteriaIds(md, validateSpec.criteria_ids_prefix);
    if (ids.length === 0) {
      issues.push(`no ${validateSpec.criteria_ids_prefix}-N criteria IDs found`);
    }
  }

  // ---- advisory payload -------------------------------------------------
  // Reported alongside the verdict but NEVER folded into `issues`, so the exit
  // code is unchanged. Same contract `handoff-check` uses for `unknown_keys`:
  // the JSON carries more than the verdict, the verdict stays narrow.
  const warnings: string[] = [
    ...findDanglingReferences(md).map((r) => `dangling cross-reference: "${r}"`),
    ...findInvalidUrls(md).map((u) => `reference does not resolve to an http(s) URL: "${u}"`),
  ];

  // Resolve "is this the DEFINE artifact" for BOTH call forms — `spin validate define`
  // (id) and `spin validate .spindle/features/<f>/DEFINE.md` (path, which is what the
  // /define command actually runs). Keying only off the id would make the coverage
  // report invisible in the real command flow.
  const defineArtifact = graph.getArtifact('define');
  const isDefineArtifact =
    artifact?.handoff === 'define' ||
    (defineArtifact?.handoff === 'define' &&
      path.basename(mdPath) === path.basename(defineArtifact.generates));

  let coverage: ReturnType<typeof computeDefineCoverage> | undefined;
  if (isDefineArtifact) {
    let criteria: string[] = [];
    let openQuestions: string[] = [];
    const sidecar = path.join(handoffDir(root, state.feature), 'define.json');
    if (fs.existsSync(sidecar)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as {
          criteria?: string[];
          open_questions?: string[];
        };
        criteria = parsed.criteria ?? [];
        openQuestions = parsed.open_questions ?? [];
      } catch {
        warnings.push('define handoff sidecar is unreadable — coverage scored without it');
      }
    }
    coverage = computeDefineCoverage({ markdown: md, criteria, openQuestions });
  }

  const advisory = {
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(coverage ? { coverage } : {}),
  };

  return issues.length === 0
    ? ok({ valid: true, path: mdPath, ...advisory })
    : blocked({ valid: false, path: mdPath, issues, ...advisory });
}

export function gateHandler(root: string, gateId: string, args: Record<string, string>): HandlerResult {
  // An unknown gate id is a malformed invocation (exit 2), NOT a domain block (exit 1) —
  // and it must never be recorded into the ledger as a failed verdict.
  if (!isGateId(gateId)) {
    return usage(`unknown gate "${gateId}" (known: ${listGates().join(', ')})`);
  }
  const ctx = buildGateContext(root, args);
  const result = runGate(gateId, ctx);
  if (runStateExists(root)) {
    try {
      recordGate(root, gateId, { passed: result.passed, reasons: result.reasons });
    } catch {
      /* gate may run without a run-state (router/review); ledger is best-effort */
    }
  }
  return result.passed ? ok(result) : blocked(result);
}

export function diffCriteriaHandler(
  root: string,
  opts: { define?: string; build?: string }
): HandlerResult {
  if (!opts.define || !opts.build) return usage('diff-criteria requires --define <f> --build <f>');
  const definePath = path.isAbsolute(opts.define) ? opts.define : path.join(root, opts.define);
  const buildPath = path.isAbsolute(opts.build) ? opts.build : path.join(root, opts.build);
  if (!fs.existsSync(definePath) || !fs.existsSync(buildPath)) {
    return usage('define and/or build handoff file not found');
  }
  let define: { criteria?: string[] };
  let build: { results?: Array<{ criterion: string; status: string }> };
  try {
    define = JSON.parse(fs.readFileSync(definePath, 'utf-8'));
    build = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
  } catch {
    return usage(
      'diff-criteria expects the JSON handoff sidecars (.spindle/.../.handoffs/define.json and build.json), not the markdown artifacts'
    );
  }
  const passed = (build.results ?? []).filter((r) => r.status === 'passed').map((r) => r.criterion);
  const diff = criteriaDiff(define.criteria ?? [], passed);
  return diff.unmet.length === 0 ? ok(diff) : blocked(diff);
}

export function handoffCheckHandler(schemaId: string, file: string): HandlerResult {
  const check = checkHandoffFile(schemaId, file);
  return check.ok ? ok(check) : blocked(check);
}

export function retryHandler(
  root: string,
  id: string,
  opts: { inc?: boolean; ok?: boolean }
): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const cap = graph.getSchema().config?.build_retry_cap ?? 3;
  if (opts.inc) {
    const count = incRetry(root, id);
    return count > cap
      ? blocked({ id, retries: count, cap, exceeded: true })
      : ok({ id, retries: count, cap, exceeded: false });
  }
  // --ok: exit 1 when the ceiling has been hit.
  const count = getRetry(root, id);
  return count >= cap ? blocked({ id, retries: count, cap, exceeded: true }) : ok({ id, retries: count, cap });
}

// `spin route <kind>` (deterministic tier resolution) is unchanged. `spin route
// --stats` (no kind) is a NEW advisory mode: it reads the run ledger and reports
// per-tier completion/token accounting + per-artifact retry counts — the same
// "sum what the model reported" doctrine as `spin budget`, reusing the shared
// aggregation in core/model-route/usage-stats.ts rather than re-deriving it here.
// Always exit 0 once a run exists (accounting, not enforcement); exit 2 only for
// a malformed invocation (no kind AND no --stats, or --stats with no run yet).
export function routeHandler(
  root: string,
  kind: string | undefined,
  opts: { budget?: string; stats?: boolean }
): HandlerResult {
  if (!kind) {
    if (!opts.stats) return usage('spin route requires <taskKind> or --stats');
    if (!runStateExists(root)) return usage('no run state — run "spin init" first');
    const state = loadRunState(root);
    return ok(aggregateUsageStats(state.events));
  }
  const budget = (opts.budget === 'low' ? 'low' : 'std') as Budget;
  try {
    return ok(route(kind, budget));
  } catch (e) {
    return usage(`${(e as Error).message}`);
  }
}

const RISKS = ['low', 'medium', 'high'];
const BREADTHS = ['single', 'few', 'many'];

export function tierHandler(opts: {
  risk?: string;
  breadth?: string;
  reversible?: boolean;
  irreversible?: boolean;
  haveContext?: boolean;
  mechanical?: boolean;
}): HandlerResult {
  if (opts.risk && !RISKS.includes(opts.risk)) return usage(`--risk must be one of: ${RISKS.join(', ')}`);
  if (opts.breadth && !BREADTHS.includes(opts.breadth)) return usage(`--breadth must be one of: ${BREADTHS.join(', ')}`);
  const signals: TierSignals = {
    mechanical: opts.mechanical === true,
    risk: opts.risk as Risk | undefined,
    breadth: opts.breadth as Breadth | undefined,
    haveContext: opts.haveContext === true,
    reversible: opts.irreversible === true ? false : opts.reversible === true ? true : undefined,
  };
  return ok({ signals, decision: classifyTier(signals) });
}

export function schemaHandler(root: string, action: string, handoffId?: string): HandlerResult {
  const schemaPath = runStateExists(root) ? schemaCopyPath(root) : null;
  if (action === 'show') {
    // `spin schema show <handoff-id>` describes a handoff's JSON shape so the
    // sidecar can be authored without reading schemas.ts (dogfood F2).
    if (handoffId) {
      const desc = describeHandoff(handoffId);
      if (!desc) {
        return usage(`unknown handoff id "${handoffId}" (known: ${listHandoffIds().join(', ')})`);
      }
      return ok(desc);
    }
    if (!schemaPath || !fs.existsSync(schemaPath)) return usage('no active schema — run "spin init"');
    return ok(loadSchema(schemaPath));
  }
  if (action === 'validate') {
    const target = schemaPath && fs.existsSync(schemaPath) ? schemaPath : null;
    if (!target) return usage('no active schema to validate — run "spin init"');
    try {
      // Shared with `spin doctor`, defined once in core/artifact-graph/schema-validate.ts.
      const result = validateSchemaContent(fs.readFileSync(target, 'utf-8'));
      if (!result.valid) return blocked({ valid: false, errors: result.errors });
      return ok({ valid: true, schema: target });
    } catch (e) {
      return blocked({ valid: false, error: (e as Error).message });
    }
  }
  return usage(`unknown schema action "${action}" (use: show | validate)`);
}

export function listTaskKindsHandler(): HandlerResult {
  return ok({ kinds: listTaskKinds() });
}

export function reconcileHandler(root: string, opts: { audit?: string }): HandlerResult {
  if (!opts.audit) return usage('reconcile requires --audit <file>');
  // Honor --root like every other file-oriented command; resolve a relative --audit
  // against the project root, not the process cwd.
  const auditPath = path.isAbsolute(opts.audit) ? opts.audit : path.join(root, opts.audit);
  if (!fs.existsSync(auditPath)) {
    return usage(`audit file not found: ${auditPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
  } catch {
    return usage(`audit file is not valid JSON: ${auditPath}`);
  }
  const check = checkHandoffObject('audit', parsed);
  if (!check.ok) {
    return blocked({
      error: 'audit file does not match AuditHandoff schema',
      schema_errors: check.errors,
    });
  }
  const data = check.data as { built: Array<{
    item: string;
    status: 'proven' | 'partial' | 'scaffolded';
    resolved_at_commit?: string | null;
    verified_in_code: boolean;
  }> };
  const report = reconcileAudit(data);
  const hasProblems = report.inconsistent.length > 0 || report.drift_open.length > 0;
  const result = {
    audit: auditPath,
    ...report,
    clean: !hasProblems,
  };
  return hasProblems ? blocked(result) : ok(result);
}

export function configDriftHandler(opts: { declared?: string; present?: string }): HandlerResult {
  if (opts.declared === undefined) return usage('config-drift requires --declared <a,b,c>');
  if (opts.present === undefined) return usage('config-drift requires --present <a,b>');

  // Comma-split, trim whitespace, drop empty strings.
  const declared = opts.declared
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const present = opts.present
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const report = configDrift(declared, present);
  return report.missing.length > 0 ? blocked(report) : ok(report);
}

export function explainHandler(gateId: string): HandlerResult {
  const doc = explainGate(gateId);
  if (!doc) {
    return usage(`unknown gate "${gateId}" (known: ${listGates().join(', ')})`);
  }
  return ok(doc);
}

export function specDriftHandler(root: string, opts: { build?: string }): HandlerResult {
  if (!opts.build) return usage('spec-drift requires --build <build-report.json>');
  const buildPath = path.isAbsolute(opts.build) ? opts.build : path.join(root, opts.build);
  if (!fs.existsSync(buildPath)) {
    return usage(`build report not found: ${buildPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(buildPath, 'utf-8'));
  } catch {
    return usage(`build report is not valid JSON: ${buildPath}`);
  }
  // Validate against the build-report schema so a malformed file fails loudly
  // rather than reading as "no drift".
  const check = checkHandoffObject('build-report', parsed);
  if (!check.ok) {
    return blocked({
      error: 'build report does not match BuildReportHandoff schema',
      schema_errors: check.errors,
    });
  }
  const results = (check.data as { results?: BuildResult[] }).results ?? [];
  const report = specDrift(results);
  const result = { build: buildPath, ...report };
  return report.clean ? ok(result) : blocked(result);
}

export function evalHandler(opts: { corpus?: string; strict?: boolean }): HandlerResult {
  const corpus = opts.corpus
    ? path.isAbsolute(opts.corpus)
      ? opts.corpus
      : path.join(process.cwd(), opts.corpus)
    : path.join(packageRoot(), 'schemas', 'evals');
  if (!fs.existsSync(corpus)) {
    return usage(`eval corpus not found: ${corpus}`);
  }
  const report = runEvalCorpus(corpus);
  // A verdict regression (a gate no longer blocks/passes as recorded) always fails.
  // --strict additionally fails when the corpus does not cover every registry gate
  // with both a pass and a block case (the fail-closed completeness discipline).
  const coverageIncomplete = opts.strict === true && !report.coverage.complete;
  const fail = report.regressions.length > 0 || coverageIncomplete;
  return fail ? blocked(report) : ok(report);
}

export function invalidateHandler(root: string, id: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  if (!graph.getArtifact(id)) return usage(`unknown artifact "${id}"`);
  // Cascade: the edited artifact + everything that transitively depends on it.
  const closure = graph.getDownstream([id]);
  const state = invalidate(root, closure);
  return ok({
    invalidated: closure,
    completed: state.completed,
    gates_cleared: true,
    approval_cleared: true,
  });
}

export function approveHandler(root: string, opts: { by?: string }): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  if (!process.stdin.isTTY) {
    return usage(
      'approval requires an interactive human terminal. Run `spin approve` yourself in a terminal before /ship.'
    );
  }
  const ctx = buildGateContext(root);
  const missing = ['define', 'design', 'build'].filter((id) => !ctx.runState?.completed.includes(id));
  if (missing.length > 0) {
    return blocked({ approved: false, reasons: ['record Define, Design and Build before approval'], unmet: missing });
  }
  const captured = captureApprovalSnapshot(ctx);
  if (!captured.ok) return blocked({ approved: false, reasons: captured.reasons, unmet: ['approval-evidence'] });
  for (const gate of ['G_DEFINE', 'G_DESIGN', 'G_BUILD']) {
    const result = runGate(gate, ctx);
    if (!result.passed) return blocked(result);
  }
  const by = opts.by ?? process.env.USER ?? 'human';
  const state = markApproved(root, by, captured.snapshot);
  return ok({ approved: true, by, at: state.approval?.at ?? null, feature: state.feature, snapshot: captured.snapshot });
}

// ---------------------------------------------------------------------------
// spin doctor / spin verify-self — orientation + build-integrity diagnostics.
// Both handlers are thin: the deterministic work lives in core/doctor/ and
// core/verify-self.ts. Kept in their own region so they never collide with
// edits elsewhere in this file.
// ---------------------------------------------------------------------------

export function doctorHandler(root: string): HandlerResult {
  // Doctor DIAGNOSES, it never blocks — every domain-level problem (no run,
  // corrupt ledger, invalid schema) is reported INSIDE the report at exit 0.
  // Exit 3 is reserved for a genuine bug in the check itself.
  try {
    return ok(runDoctor(root));
  } catch (e) {
    return { code: 3, json: { error: `spin doctor crashed: ${(e as Error).message}` } };
  }
}

export function verifySelfHandler(root: string, opts: { manifest?: string }): HandlerResult {
  const manifestPath = opts.manifest
    ? path.isAbsolute(opts.manifest)
      ? opts.manifest
      : path.join(root, opts.manifest)
    : path.join(root, 'verification', 'checksums.json');
  if (!fs.existsSync(manifestPath)) {
    return usage(`checksum manifest not found: ${manifestPath} — run \`npm run build\` first`);
  }
  try {
    const result = verifySelf(root, manifestPath);
    return result.passed ? ok(result) : blocked(result);
  } catch (e) {
    return { code: 3, json: { error: `spin verify-self crashed: ${(e as Error).message}` } };
  }
}

export { markIncomplete };
