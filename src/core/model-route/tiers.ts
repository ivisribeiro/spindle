// Orchestration tier (T0/T1/T2) — an axis ORTHOGONAL to the model tier
// (Haiku/Sonnet/Opus in policy.ts). The model tier answers "which model for THIS
// agent"; the orchestration tier answers "how much orchestration does this whole
// task deserve" — main loop vs one agent vs a fan-out with an adversary.
//
// This exists because the expensive mistake is treating a T0/T1 task as T2:
// firing a multi-agent fan-out + adversary at something a single pass (or the
// main loop) would have done. It is the model-routing doctrine ("cheapest tier
// that verifiably does the task") applied to the ORCHESTRATION decision itself.

export type OrchestrationTier = 'T0' | 'T1' | 'T2';
export type Risk = 'low' | 'medium' | 'high';
export type Breadth = 'single' | 'few' | 'many';
export type AdversaryMode = 'none' | 'optional-single' | 'selective';

export interface TierSignals {
  /** Mechanical/template work: rename, config, one doc from an existing result, a lookup. */
  mechanical?: boolean;
  /** Easily reversible? Defaults to true. An irreversible action (deploy, delete, publish) forces T2. */
  reversible?: boolean;
  /** Stakes if it goes wrong. `high` (security/correctness/irreversible) forces T2. Defaults to medium. */
  risk?: Risk;
  /** How many files/subsystems does it span? Defaults to few. */
  breadth?: Breadth;
  /**
   * Do I already hold the material/context (memory, a backlog doc, files in context)?
   * If true, the task is RE-DERIVATION, not discovery — never fan out N agents to
   * re-read what is already in hand. This is the lesson that pulls planning/audit
   * of a known project down from T2 to T1.
   */
  haveContext?: boolean;
}

export interface TierDecision {
  tier: OrchestrationTier;
  orchestration: string;
  agents: string; // human-readable agent budget
  adversary: AdversaryMode;
  budgetCap: 'n/a' | 'recommended' | 'required';
  reason: string;
}

const TIER_SHAPE: Record<OrchestrationTier, Omit<TierDecision, 'reason'>> = {
  T0: {
    tier: 'T0',
    orchestration: 'main loop — do it directly, no subagents',
    agents: '0',
    adversary: 'none',
    budgetCap: 'n/a',
  },
  T1: {
    tier: 'T1',
    orchestration: 'one agent (cheapest model that works), or draft in the main loop when context is already held; no fan-out',
    agents: '1 (+ at most 1 adversary if the output is consequential)',
    adversary: 'optional-single',
    budgetCap: 'recommended',
  },
  T2: {
    tier: 'T2',
    orchestration: 'fan-out for genuine discovery with SHARED context; adversary on critical items only',
    agents: 'many (bounded)',
    adversary: 'selective',
    budgetCap: 'required',
  },
};

function decide(tier: OrchestrationTier, reason: string): TierDecision {
  return { ...TIER_SHAPE[tier], reason };
}

/**
 * Classify a task into an orchestration tier. Pure and deterministic.
 *
 * Order of judgment (first match wins):
 *  1. mechanical, or a trivial held-context lookup -> T0
 *  2. high risk or irreversible -> T2 (always; the adversary stays selective)
 *  3. context already held -> T1 (re-derivation, not discovery; never N re-readers)
 *  4. broad discovery across material NOT held -> T2
 *  5. otherwise bounded -> T1
 */
export function classifyTier(signals: TierSignals = {}): TierDecision {
  const reversible = signals.reversible !== false;
  const risk: Risk = signals.risk ?? 'medium';
  const breadth: Breadth = signals.breadth ?? 'few';
  const haveContext = signals.haveContext === true;

  if (
    signals.mechanical === true ||
    (haveContext && breadth === 'single' && risk === 'low' && reversible)
  ) {
    return decide('T0', 'mechanical or a trivial lookup — the main loop does it directly');
  }

  if (risk === 'high' || !reversible) {
    return decide(
      'T2',
      'high-stakes or irreversible — fan out and adversarially verify the critical items'
    );
  }

  if (haveContext) {
    return decide(
      'T1',
      'context already held — this is re-derivation, not discovery; draft in the main loop + at most one adversary, never N agents re-reading the same material'
    );
  }

  if (breadth === 'many') {
    return decide(
      'T2',
      'broad discovery across material not yet held — fan out to cover it, share context, cap the budget'
    );
  }

  return decide('T1', 'substantive but bounded — a single agent on the cheapest model that works');
}

export const TIER_GUIDE: ReadonlyArray<{ tier: OrchestrationTier; when: string }> = [
  { tier: 'T0', when: 'rename, config, one doc from an existing result, a lookup, mechanical edit' },
  { tier: 'T1', when: 'one analysis/file/review; OR planning/audit of a project whose context I already hold' },
  { tier: 'T2', when: 'architecture, security-critical, irreversible, or broad discovery across unfamiliar material' },
];
