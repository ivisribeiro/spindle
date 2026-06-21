import type { RunState } from '../run/run-state.schema.js';
import type { ArtifactGraph } from '../artifact-graph/graph.js';

// Gates read the FILESYSTEM and RUN-STATE only — never conversation memory.
// That makes every verdict idempotent and crash-safe: re-running a gate from
// the same files yields the same result.

export interface GateContext {
  root: string; // project root (contains .spindle/)
  args: Record<string, string>; // CLI-passed args (paths, etc.)
  runState: RunState | null;
  graph: ArtifactGraph | null;
  featureDir: string | null; // .spindle/features/<feature>
  handoffDir: string | null; // .spindle/features/<feature>/.handoffs
}

export interface GateResult {
  gate: string;
  passed: boolean;
  reasons: string[];
  unmet: string[]; // concrete unmet items (missing files, unmet criteria, etc.)
}

export type GateFn = (ctx: GateContext) => GateResult;

export function pass(gate: string, reasons: string[] = []): GateResult {
  return { gate, passed: true, reasons, unmet: [] };
}

export function block(gate: string, reasons: string[], unmet: string[] = []): GateResult {
  return { gate, passed: false, reasons, unmet };
}
