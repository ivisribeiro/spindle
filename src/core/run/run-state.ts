import * as fs from 'node:fs';
import * as path from 'node:path';
import { RunStateSchema, type RunState, type GateRecord, type RunEvent, type Usage } from './run-state.schema.js';

// Atomic, Zod-validated read/write of .spindle/run.json. This module is the single
// writer of run-state. The LLM never writes here; it only triggers CLI commands
// that call these functions.

export const RUN_DIR = '.spindle';
export const RUN_FILE = 'run.json';
export const SCHEMA_FILE = 'schema.yaml';

export function runDirPath(root: string): string {
  return path.join(root, RUN_DIR);
}

export function runFilePath(root: string): string {
  return path.join(root, RUN_DIR, RUN_FILE);
}

/** Base dir where the active feature's artifacts live. */
export function featureDir(root: string, feature: string): string {
  return path.join(root, RUN_DIR, 'features', feature);
}

export function handoffDir(root: string, feature: string): string {
  return path.join(featureDir(root, feature), '.handoffs');
}

export function schemaCopyPath(root: string): string {
  return path.join(root, RUN_DIR, SCHEMA_FILE);
}

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Atomic write: write to a temp file then rename (rename is atomic on POSIX). */
export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

export function runStateExists(root: string): boolean {
  return fs.existsSync(runFilePath(root));
}

export function loadRunState(root: string): RunState {
  const file = runFilePath(root);
  if (!fs.existsSync(file)) {
    throw new RunStateError(`No run state at ${file}. Run "spin init" first.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    throw new RunStateError(`Corrupt run state JSON at ${file}.`);
  }
  const result = RunStateSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new RunStateError(`Invalid run state: ${errors}`);
  }
  return result.data;
}

export function saveRunState(root: string, state: RunState): RunState {
  const next: RunState = { ...state, updatedAt: nowIso() };
  // Validate before persisting so we never write a malformed ledger.
  const result = RunStateSchema.safeParse(next);
  if (!result.success) {
    const errors = result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    throw new RunStateError(`Refusing to save invalid run state: ${errors}`);
  }
  atomicWrite(runFilePath(root), JSON.stringify(result.data, null, 2) + '\n');
  return result.data;
}

export function initRunState(root: string, schema: string, feature: string): RunState {
  const ts = nowIso();
  const state: RunState = {
    version: 1,
    schema,
    feature,
    completed: [],
    retries: {},
    gates: {},
    events: [],
    approval: null,
    createdAt: ts,
    updatedAt: ts,
  };
  return saveRunState(root, state);
}

/** Record human sign-off. Called by `spin approve`, which gates on an interactive TTY
 *  so an automated agent cannot reach this path. G_SHIP requires the result. */
export function markApproved(root: string, by: string): RunState {
  const state = loadRunState(root);
  const at = nowIso();
  state.approval = { at, by };
  state.events = [...state.events, { kind: 'approve', at, by }];
  return saveRunState(root, state);
}

export function markComplete(root: string, id: string, usage?: Usage): RunState {
  const state = loadRunState(root);
  // Append a 'complete' event only when the id is NEWLY completed, so re-running
  // `spin complete <id>` on an already-done artifact stays idempotent on the ledger.
  if (!state.completed.includes(id)) {
    state.completed = [...state.completed, id].sort();
    state.events = [...state.events, { kind: 'complete', at: nowIso(), id, ...(usage ? { usage } : {}) }];
  }
  return saveRunState(root, state);
}

export function markIncomplete(root: string, ids: string[]): RunState {
  const state = loadRunState(root);
  const drop = new Set(ids);
  state.completed = state.completed.filter((c) => !drop.has(c));
  // Re-gating invalidates a prior human sign-off — work changed since approval, so the
  // approval is stale and G_SHIP must require a fresh `spin approve`.
  if (ids.length > 0) state.approval = null;
  return saveRunState(root, state);
}

/** Invalidate a set of artifacts after an edit (the /iterate cascade). Drops them from
 *  completed[], and — conservatively — voids ALL gate verdicts and the human approval, so
 *  no stale-green verdict survives an edit. Gates re-run cheaply and deterministically; the
 *  caller passes the downstream closure (graph.getDownstream) so dependents re-gate too. */
export function invalidate(root: string, ids: string[]): RunState {
  const state = loadRunState(root);
  const drop = new Set(ids);
  state.completed = state.completed.filter((c) => !drop.has(c));
  state.gates = {};
  state.approval = null;
  return saveRunState(root, state);
}

export function getRetry(root: string, id: string): number {
  const state = loadRunState(root);
  return state.retries[id] ?? 0;
}

export function incRetry(root: string, id: string): number {
  const state = loadRunState(root);
  const next = (state.retries[id] ?? 0) + 1;
  state.retries = { ...state.retries, [id]: next };
  // A retry is always a genuine state change (a deliberate counter bump), so every
  // increment is its own event.
  state.events = [...state.events, { kind: 'retry', at: nowIso(), id, attempt: next }];
  saveRunState(root, state);
  return next;
}

export function recordGate(root: string, gateId: string, record: Omit<GateRecord, 'at'>): RunState {
  const state = loadRunState(root);
  const at = nowIso();
  const reasons = record.reasons ?? [];
  state.gates = { ...state.gates, [gateId]: { passed: record.passed, reasons, at } };
  // Append to the trajectory only when the verdict CHANGES from the last recorded
  // verdict for this gate. Re-running an unchanged gate adds no event, so the ledger
  // (and thus `spin trace`) is idempotent on re-run.
  const priorForGate = state.events.filter(
    (e): e is Extract<RunEvent, { kind: 'gate' }> => e.kind === 'gate' && e.gate === gateId
  );
  const last = priorForGate[priorForGate.length - 1];
  const changed =
    !last || last.passed !== record.passed || JSON.stringify(last.reasons) !== JSON.stringify(reasons);
  if (changed) {
    state.events = [...state.events, { kind: 'gate', at, gate: gateId, passed: record.passed, reasons }];
  }
  return saveRunState(root, state);
}

export function completedSet(root: string): Set<string> {
  return new Set(loadRunState(root).completed);
}
