import * as fs from 'node:fs';
import * as path from 'node:path';
import { ArtifactGraph } from '../artifact-graph/graph.js';
import { validateSchemaContent } from '../artifact-graph/schema-validate.js';
import {
  runDirPath,
  runFilePath,
  runStateExists,
  loadRunState,
  schemaCopyPath,
  RunStateError,
} from '../run/run-state.js';
import type { GateRecord } from '../run/run-state.schema.js';
import { checkNodeVersion, type NodeVersionCheck } from './node-check.js';
import {
  recommendInit,
  recommendFixRunState,
  recommendFixSchema,
  recommendFromReadiness,
  type NextRecommendation,
} from './recommend.js';

// `spin doctor` — read-only orientation + environment diagnosis. It NEVER blocks:
// every check reports what it found (including "corrupt" / "invalid"), and the
// worst outcome is a recommendation to fix something by hand. This is the
// first-run / lost-user entry point, so it must degrade gracefully at every step
// rather than throwing — a crash here is the one thing `spin doctor` cannot afford.

export interface DoctorReport {
  node: NodeVersionCheck;
  packageJson: { found: boolean; path: string | null };
  spindle: { dirExists: boolean; dirPath: string; runFileExists: boolean; runFilePath: string };
  runState: {
    loaded: boolean;
    error: string | null;
    schema: string | null;
    feature: string | null;
    completed: string[];
    gates: Record<string, GateRecord>;
    gatesSummary: { total: number; passed: number; blocked: number };
  };
  schema: { exists: boolean; path: string | null; valid: boolean | null; errors: string[] };
  next: NextRecommendation;
}

function readEnginesNode(root: string): string | null {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { engines?: { node?: unknown } };
    return typeof pkg.engines?.node === 'string' ? pkg.engines.node : null;
  } catch {
    return null;
  }
}

const emptyRunState = (): DoctorReport['runState'] => ({
  loaded: false,
  error: null,
  schema: null,
  feature: null,
  completed: [],
  gates: {},
  gatesSummary: { total: 0, passed: 0, blocked: 0 },
});

const emptySchema = (): DoctorReport['schema'] => ({
  exists: false,
  path: null,
  valid: null,
  errors: [],
});

/** Ready/gate-blocked/complete over the artifact graph — deliberately a small,
 *  self-contained readiness pass (mirrors, but does not import from,
 *  `nextHandler` in commands/handlers.ts) so doctor never depends on the
 *  command layer. Skips `nextHandler`'s on-disk crash-recovery detection —
 *  irrelevant to "what command should I run next". */
function computeReadiness(
  graph: ArtifactGraph,
  completed: Set<string>,
  gates: Record<string, GateRecord>
): { ready: Array<{ id: string }>; gateBlocked: Record<string, string[]>; complete: boolean } {
  const finalId = graph.getFinalArtifactId();
  const terminal = graph.getTerminalGates();
  const gateUnpassed = (g: string): boolean => gates[g]?.passed !== true;

  const ready: Array<{ id: string }> = [];
  const gateBlocked: Record<string, string[]> = {};
  for (const id of graph.getNextArtifacts(completed)) {
    const required = [...graph.getRequiredGatesBefore(id), ...(id === finalId ? terminal : [])];
    const unmetGates = [...new Set(required)].filter(gateUnpassed);
    if (unmetGates.length > 0) {
      gateBlocked[id] = unmetGates;
      continue;
    }
    ready.push({ id });
  }
  return {
    ready,
    gateBlocked,
    complete: graph.isComplete(completed) && terminal.every((g) => !gateUnpassed(g)),
  };
}

export function runDoctor(root: string): DoctorReport {
  const node = checkNodeVersion(process.version, readEnginesNode(root));
  const pkgPath = path.join(root, 'package.json');
  const packageJson = { found: fs.existsSync(pkgPath), path: fs.existsSync(pkgPath) ? pkgPath : null };

  const dirExists = fs.existsSync(runDirPath(root));
  const runFileExists = runStateExists(root);
  const spindle = { dirExists, dirPath: runDirPath(root), runFileExists, runFilePath: runFilePath(root) };

  if (!runFileExists) {
    return { node, packageJson, spindle, runState: emptyRunState(), schema: emptySchema(), next: recommendInit() };
  }

  // Load the ledger. A corrupt/invalid run.json is reported, never thrown — doctor
  // diagnoses, it never blocks.
  let runState: DoctorReport['runState'];
  try {
    const state = loadRunState(root);
    const gateEntries = Object.values(state.gates);
    runState = {
      loaded: true,
      error: null,
      schema: state.schema,
      feature: state.feature,
      completed: state.completed,
      gates: state.gates,
      gatesSummary: {
        total: gateEntries.length,
        passed: gateEntries.filter((g) => g.passed).length,
        blocked: gateEntries.filter((g) => !g.passed).length,
      },
    };
  } catch (e) {
    const message = e instanceof RunStateError ? e.message : `unexpected error loading run state: ${(e as Error).message}`;
    runState = { ...emptyRunState(), error: message };
    return { node, packageJson, spindle, runState, schema: emptySchema(), next: recommendFixRunState(message) };
  }

  // Validate the active schema — reuses the SAME core check `spin schema validate`
  // runs (core/artifact-graph/schema-validate.ts), never a re-implementation.
  const schemaPath = schemaCopyPath(root);
  const schemaFileExists = fs.existsSync(schemaPath);
  let schema: DoctorReport['schema'];
  if (!schemaFileExists) {
    schema = emptySchema();
    return {
      node,
      packageJson,
      spindle,
      runState,
      schema,
      next: recommendFixSchema(['.spindle/schema.yaml is missing']),
    };
  }
  let content: string;
  try {
    content = fs.readFileSync(schemaPath, 'utf-8');
    const result = validateSchemaContent(content);
    schema = { exists: true, path: schemaPath, valid: result.valid, errors: result.errors };
    if (!result.valid) {
      return { node, packageJson, spindle, runState, schema, next: recommendFixSchema(result.errors) };
    }
  } catch (e) {
    const message = (e as Error).message;
    schema = { exists: true, path: schemaPath, valid: false, errors: [message] };
    return { node, packageJson, spindle, runState, schema, next: recommendFixSchema([message]) };
  }

  // Both the ledger and the schema are healthy — compute the real next step. Built
  // from the SAME content just validated (no second read, no re-parse surprise).
  try {
    const graph = ArtifactGraph.fromYamlContent(content);
    const completed = new Set(runState.completed);
    const readiness = computeReadiness(graph, completed, runState.gates);
    const next = recommendFromReadiness({
      ready: readiness.ready,
      gateBlocked: readiness.gateBlocked,
      complete: readiness.complete,
    });
    return { node, packageJson, spindle, runState, schema, next };
  } catch (e) {
    const message = (e as Error).message;
    return { node, packageJson, spindle, runState, schema, next: recommendFixSchema([message]) };
  }
}
