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
import { buildGateContext, runGate } from '../core/gates/gate-runner.js';
import { checkHandoffFile } from '../core/handoff/handoff-check.js';
import { criteriaDiff } from '../core/validation/criteria-diff.js';
import { validateSections, hasManifestTable, extractCriteriaIds } from '../core/validation/md-section-validator.js';
import { route, listTaskKinds, type Budget } from '../core/model-route/policy.js';
import { classifyTier, type TierSignals, type Risk, type Breadth } from '../core/model-route/tiers.js';

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

  const state = markComplete(root, id);
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

export function schemaHandler(root: string, action: string): HandlerResult {
  const schemaPath = runStateExists(root) ? schemaCopyPath(root) : null;
  if (action === 'show') {
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

export { markIncomplete };
