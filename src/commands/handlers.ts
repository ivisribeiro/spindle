import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactGraph } from '../core/artifact-graph/graph.js';
import { loadSchema, parseSchema } from '../core/artifact-graph/schema.js';
import { detectCompleted } from '../core/artifact-graph/state.js';
import {
  initRunState,
  loadRunState,
  markComplete,
  markApproved,
  markIncomplete,
  completedSet,
  incRetry,
  getRetry,
  recordGate,
  runStateExists,
  featureDir,
  handoffDir,
  schemaCopyPath,
} from '../core/run/run-state.js';
import { Usage, type RunEvent } from '../core/run/run-state.schema.js';
import { buildGateContext, runGate } from '../core/gates/gate-runner.js';
import { checkHandoffFile, checkHandoffObject } from '../core/handoff/handoff-check.js';
import { criteriaDiff } from '../core/validation/criteria-diff.js';
import { validateSections, hasManifestTable, extractCriteriaIds } from '../core/validation/md-section-validator.js';
import { route, listTaskKinds, type Budget } from '../core/model-route/policy.js';
import { classifyTier, type TierSignals, type Risk, type Breadth } from '../core/model-route/tiers.js';
import { reconcileAudit } from '../core/reconcile.js';
import { configDrift } from '../core/config-drift.js';
import { explainGate } from '../core/gates/gate-docs.js';
import { listGates } from '../core/gates/registry.js';
import { describeHandoff, listHandoffIds } from '../core/handoff/describe.js';
import { specDrift, type BuildResult } from '../core/spec-drift.js';
import { runEvalCorpus } from '../core/eval/eval.js';

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
function effectiveCompleted(root: string, graph: ArtifactGraph): Set<string> {
  const state = loadRunState(root);
  const fromState = completedSet(root);
  const fromFs = detectCompleted(graph, featureDir(root, state.feature));
  return new Set<string>([...fromState, ...fromFs]);
}

export function initHandler(root: string, opts: { schema?: string; feature?: string }): HandlerResult {
  const schemaName = opts.schema ?? 'sdd';
  const feature = opts.feature ?? 'feature';
  const src = bundledSchemaPath(schemaName);
  if (!fs.existsSync(src)) {
    return usage(`unknown bundled schema "${schemaName}" (expected schemas/${schemaName}/schema.yaml)`);
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
  return ok({ initialized: true, schema: schemaName, feature, runState: state });
}

export function stateHandler(root: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  return ok(loadRunState(root));
}

export function traceHandler(root: string): HandlerResult {
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

  return ok({
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
  });
}

export function budgetHandler(root: string, opts: { maxTokens?: string }): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  let max: number | null = null;
  if (opts.maxTokens !== undefined) {
    const n = Number(opts.maxTokens);
    if (!Number.isFinite(n) || n < 0) return usage('--max-tokens must be a non-negative number');
    max = Math.floor(n);
  }

  const state = loadRunState(root);
  const completes = state.events.filter(
    (e): e is Extract<RunEvent, { kind: 'complete' }> => e.kind === 'complete'
  );

  // Reconcile reported spend per tier. The CLI only SUMS numbers the model handed it
  // on the handoff sidecar — it never tokenizes, estimates, or prices. This is
  // accounting, not enforcement: it cannot independently verify a self-reported count.
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
  const overBudget = max != null && anyReported && total > max;

  // ADVISORY by design: always exit 0. A genuinely T2 task SHOULD cost a lot; budget
  // accounting must never block legitimate spend. The signal is the `over_budget`
  // flag + warning, not an exit code.
  return ok({
    feature: state.feature,
    reported: anyReported ? { tokens_in: tokensIn, tokens_out: tokensOut, total } : null,
    by_tier: byTier,
    max_tokens: max,
    over_budget: overBudget,
    advisory: true,
    warning: overBudget
      ? `reported spend ${total} tokens exceeds the declared budget of ${max} — advisory only, not enforced`
      : null,
  });
}

export function fanoutCheckHandler(root: string): HandlerResult {
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

export function nextHandler(root: string): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  const graph = activeGraph(root);
  const completed = effectiveCompleted(root, graph);
  const ready = graph.getNextArtifacts(completed).map((id) => {
    const a = graph.getArtifact(id)!;
    return { id, model: a.model ?? null, parallel_group: a.parallel_group ?? null };
  });
  const blockedArtifacts = graph.getBlocked(completed);
  return ok({
    feature: loadRunState(root).feature,
    ready,
    blocked: blockedArtifacts,
    complete: graph.isComplete(completed),
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
    // Persist the validated handoff canonically so gates read it deterministically.
    const state = loadRunState(root);
    const dest = path.join(handoffDir(root, state.feature), `${id}.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(check.data, null, 2) + '\n');
  }

  // Opaque, model-reported usage rides on the sidecar's optional top-level `usage`
  // key (the artifact schema strips unknown keys, so this never affects validation).
  // The CLI only RECORDS it — it never computes or prices tokens. Usage is advisory:
  // a malformed or absent annotation never blocks completion.
  let reportedUsage: Usage | undefined;
  if (opts.handoff && fs.existsSync(opts.handoff)) {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.handoff, 'utf-8')) as { usage?: unknown };
      if (raw.usage !== undefined) {
        const parsed = Usage.safeParse(raw.usage);
        if (parsed.success) reportedUsage = parsed.data;
      }
    } catch {
      /* usage is advisory; never block completion on it */
    }
  }

  const state = markComplete(root, id, reportedUsage);
  return ok({ completed: id, runState: state });
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

  return issues.length === 0
    ? ok({ valid: true, path: mdPath })
    : blocked({ valid: false, path: mdPath, issues });
}

export function gateHandler(root: string, gateId: string, args: Record<string, string>): HandlerResult {
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

export function routeHandler(kind: string, opts: { budget?: string }): HandlerResult {
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
      parseSchema(fs.readFileSync(target, 'utf-8'));
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

export function reconcileHandler(opts: { audit?: string }): HandlerResult {
  if (!opts.audit) return usage('reconcile requires --audit <file>');
  const auditPath = path.isAbsolute(opts.audit) ? opts.audit : path.join(process.cwd(), opts.audit);
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

export function approveHandler(root: string, opts: { by?: string }): HandlerResult {
  if (!runStateExists(root)) return usage('no run state — run "spin init" first');
  // The seam applied to sign-off: approval requires a human at an interactive TTY. An
  // automated agent's shell is not a TTY, so the model cannot grant it. There is NO
  // bypass flag — that is the whole point (G_SHIP depends on this being un-fakeable).
  if (!process.stdin.isTTY) {
    return usage(
      'approval requires an interactive human terminal — an automated agent cannot approve. Run `spin approve` yourself in a terminal before /ship.'
    );
  }
  const by = opts.by ?? process.env.USER ?? 'human';
  const state = markApproved(root, by);
  return ok({ approved: true, by, at: state.approval?.at ?? null, feature: state.feature });
}

export { markIncomplete };
