// Pure model-routing resolver. Default to the cheapest tier that can VERIFIABLY
// do the task. Two enforced principles:
//   (a) the verifier outranks-or-equals the generator on any critical gate — the
//       adversary/architect/review-judge floors are opus and never downgrade;
//   (b) tier downgrades under --budget low are allowed ONLY where a deterministic
//       gate backstops the output.
// Consumed two ways: static `model:` per artifact/agent, and `spin route <kind>`.

export type Tier = 'haiku' | 'sonnet' | 'opus';
export type Budget = 'std' | 'low';

export const MODEL_IDS: Record<Tier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-8',
};

const TIER_RANK: Record<Tier, number> = { haiku: 0, sonnet: 1, opus: 2 };
const TIER_BY_RANK: Tier[] = ['haiku', 'sonnet', 'opus'];

interface KindDef {
  tier: Tier; // natural tier at std budget
  floor: Tier; // never resolve below this
  downgradable: boolean; // safe to drop one tier under --budget low (gate-backstopped)
  reason: string;
}

// The routing table. HAIKU = mechanical + gate-backstopped. SONNET = analysis /
// authoring / synthesis. OPUS = deepest reasoning + adversarial.
export const TASK_KINDS: Record<string, KindDef> = {
  // --- mechanical (haiku) — a downstream gate or validator catches mistakes ---
  'file-read': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'mechanical read' },
  'structure-extract': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'mechanical extraction, gate-validated' },
  'frontmatter-parse': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'parse, G_ROUTER_COVERAGE validates' },
  'template-fill': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'fill a template, spin validate checks' },
  'format-convert': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'mechanical conversion' },
  'claim-extract': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'extraction, claim handoff validated' },
  'ship-prose': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'archive prose, G_SHIP already passed in code' },
  'section-scan': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'scan one CLAUDE.md section' },
  'router-assemble': { tier: 'haiku', floor: 'haiku', downgradable: false, reason: 'string assembly, bijection gated' },

  // --- authoring (sonnet) — downgradable to haiku only where gate-backstopped ---
  'spec-authoring': { tier: 'sonnet', floor: 'sonnet', downgradable: false, reason: 'spec authoring needs judgment' },
  'design-synthesis': { tier: 'sonnet', floor: 'sonnet', downgradable: false, reason: 'design synthesis' },
  'code-build': { tier: 'sonnet', floor: 'haiku', downgradable: true, reason: 'per-file build, G_BUILD backstops' },
  'kb-concept': { tier: 'sonnet', floor: 'haiku', downgradable: true, reason: 'concept authoring, G_KB_COVERAGE backstops' },
  'finding-analysis': { tier: 'sonnet', floor: 'sonnet', downgradable: false, reason: 'security/arch finding analysis' },
  'claim-verify': { tier: 'sonnet', floor: 'sonnet', downgradable: false, reason: 'claim verification' },
  'migration-plan': { tier: 'sonnet', floor: 'sonnet', downgradable: false, reason: 'migration plan authoring' },
  merge: { tier: 'sonnet', floor: 'haiku', downgradable: true, reason: 'deterministic merge assist' },

  // --- critical (opus) — NEVER downgrade; verifier outranks generator ---
  architect: { tier: 'opus', floor: 'opus', downgradable: false, reason: 'architecture decision' },
  'define-intent': { tier: 'opus', floor: 'opus', downgradable: false, reason: 'requirements intent + ADRs' },
  'design-intent': { tier: 'opus', floor: 'opus', downgradable: false, reason: 'design intent + ADRs' },
  adversary: { tier: 'opus', floor: 'opus', downgradable: false, reason: 'adversarial challenger — must outrank generator' },
  'review-judge': { tier: 'opus', floor: 'opus', downgradable: false, reason: 'final judge of CRITICAL findings' },
  'equivalence-break': { tier: 'opus', floor: 'opus', downgradable: false, reason: 'try to break migration equivalence' },
};

export interface RouteResult {
  kind: string;
  tier: Tier;
  model: string;
  budget: Budget;
  reason: string;
}

export class UnknownTaskKindError extends Error {
  constructor(kind: string) {
    super(
      `unknown task kind "${kind}". Known kinds: ${Object.keys(TASK_KINDS).sort().join(', ')}`
    );
    this.name = 'UnknownTaskKindError';
  }
}

function lowerOneTier(tier: Tier, floor: Tier): Tier {
  const target = Math.max(TIER_RANK[tier] - 1, TIER_RANK[floor]);
  return TIER_BY_RANK[target];
}

export function route(kind: string, budget: Budget = 'std'): RouteResult {
  const def = TASK_KINDS[kind];
  if (!def) throw new UnknownTaskKindError(kind);

  let tier = def.tier;
  let reason = def.reason;

  if (budget === 'low' && def.downgradable) {
    const lowered = lowerOneTier(def.tier, def.floor);
    if (lowered !== tier) {
      tier = lowered;
      reason = `${def.reason}; downgraded under --budget low (gate-backstopped, floor=${def.floor})`;
    }
  }

  return { kind, tier, model: MODEL_IDS[tier], budget, reason };
}

export function listTaskKinds(): string[] {
  return Object.keys(TASK_KINDS).sort();
}
