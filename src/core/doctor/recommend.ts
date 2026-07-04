// Deterministic "what's the exact next command" mapping — the same reasoning
// `plugin/commands/core/spin.md` does in prose, encoded here so `spin doctor`
// can answer it without a model in the loop. The artifact-id -> slash-command
// table below is the closed set for the SDD/brownfield/KB schemas Spindle ships;
// it is not meant to guess an arbitrary forked schema's artifact ids.

export type NextAction = 'init' | 'fix_run_state' | 'fix_schema' | 'run_command' | 'run_gate' | 'complete';

export interface NextRecommendation {
  action: NextAction;
  /** The exact command to run next, or null when there is nothing actionable
   *  (e.g. the run is complete, or the artifact graph has no known command). */
  command: string | null;
  reason: string;
}

/** artifact id -> the slash command that produces it, mirroring the table in
 *  plugin/commands/core/spin.md. */
const ARTIFACT_TO_COMMAND: Record<string, string> = {
  brainstorm: '/brainstorm',
  define: '/define',
  design: '/design',
  build: '/build',
  ship: '/ship',
  audit: '/audit',
  manifest: '/create-kb',
  concepts: '/create-kb',
  'quick-reference': '/create-kb',
  index: '/create-kb',
};

export function commandForArtifact(id: string): string | null {
  return ARTIFACT_TO_COMMAND[id] ?? null;
}

export function recommendInit(): NextRecommendation {
  return {
    action: 'init',
    command: 'spin init --schema <sdd|kb|brownfield> --feature <slug>',
    reason:
      'no active run in this directory — scaffold one with `spin init`, or let /brainstorm, /define, or /audit do it for you',
  };
}

export function recommendFixRunState(error: string): NextRecommendation {
  return {
    action: 'fix_run_state',
    command: null,
    reason: `.spindle/run.json exists but did not load: ${error} — spin has no repair command; inspect or restore the file by hand`,
  };
}

export function recommendFixSchema(errors: string[]): NextRecommendation {
  return {
    action: 'fix_schema',
    command: 'spin schema validate',
    reason: `the active .spindle/schema.yaml fails validation (${errors.join('; ') || 'see spin schema validate'}) — run \`spin schema validate\` for the full report`,
  };
}

export interface ReadinessInput {
  ready: Array<{ id: string }>;
  gateBlocked: Record<string, string[]>;
  complete: boolean;
}

export function recommendFromReadiness(input: ReadinessInput): NextRecommendation {
  if (input.complete) {
    return {
      action: 'complete',
      command: null,
      reason: 'every artifact is complete and every terminal gate has passed — the run is done',
    };
  }
  if (input.ready.length > 0) {
    // `ready` is already sorted (ArtifactGraph.getNextArtifacts sorts by id) — pick
    // the first so the recommendation is deterministic across repeated calls.
    const id = input.ready[0].id;
    const command = commandForArtifact(id);
    return command
      ? { action: 'run_command', command, reason: `artifact "${id}" is ready — run ${command}` }
      : {
          action: 'run_command',
          command: `spin complete ${id}`,
          reason: `artifact "${id}" is ready but has no known slash command — dispatch its worker, then \`spin complete ${id}\``,
        };
  }
  const blockedIds = Object.keys(input.gateBlocked).sort();
  if (blockedIds.length > 0) {
    const id = blockedIds[0];
    const gates = input.gateBlocked[id];
    return {
      action: 'run_gate',
      command: `spin gate ${gates[0]}`,
      reason: `artifact "${id}" is waiting on gate ${gates.join(', ')} — run its owning slash command (which runs the gate itself)`,
    };
  }
  return {
    action: 'run_command',
    command: 'spin next',
    reason: 'nothing is ready and nothing is gate-blocked yet — run `spin next` for the raw readiness detail',
  };
}
