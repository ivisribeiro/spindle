import type { RunEvent } from '../run/run-state.schema.js';
import type { Tier } from './policy.js';

// Advisory routing accounting over the run ledger's events[] — backs
// `spin route --stats`. Same doctrine as `spin budget` (budgetHandler in
// commands/handlers.ts): the CLI only SUMS numbers a worker self-reported on
// its handoff sidecar (`usage.tier`/`tokens_in`/`tokens_out`). No tokenizing,
// no pricing, no independent verification — accounting, not enforcement.

const KNOWN_TIERS: readonly Tier[] = ['haiku', 'sonnet', 'opus'];

export interface TierUsage {
  completions: number;
  tokens_in: number;
  tokens_out: number;
}

export interface UsageStats {
  byTier: Record<Tier, TierUsage>;
  retries: Record<string, number>;
  /** Completions whose usage was missing or reported an unrecognized tier —
   *  honest "we don't know" bucket, distinct from a known tier with zero spend. */
  unattributed: number;
}

function emptyTierUsage(): TierUsage {
  return { completions: 0, tokens_in: 0, tokens_out: 0 };
}

function isKnownTier(tier: string | undefined): tier is Tier {
  return tier !== undefined && (KNOWN_TIERS as readonly string[]).includes(tier);
}

/** Pure aggregation over recorded events. Exported so `spin route --stats`
 *  (and any future consumer) reuses one implementation instead of each
 *  re-deriving its own per-tier sums. */
export function aggregateUsageStats(events: readonly RunEvent[]): UsageStats {
  const byTier: Record<Tier, TierUsage> = {
    haiku: emptyTierUsage(),
    sonnet: emptyTierUsage(),
    opus: emptyTierUsage(),
  };
  let unattributed = 0;

  for (const e of events) {
    if (e.kind !== 'complete') continue;
    const tier = e.usage?.tier;
    if (!isKnownTier(tier)) {
      unattributed++;
      continue;
    }
    const bucket = byTier[tier];
    bucket.completions++;
    if (e.usage?.tokens_in != null) bucket.tokens_in += e.usage.tokens_in;
    if (e.usage?.tokens_out != null) bucket.tokens_out += e.usage.tokens_out;
  }

  const retries: Record<string, number> = {};
  for (const e of events) {
    if (e.kind !== 'retry') continue;
    retries[e.id] = Math.max(retries[e.id] ?? 0, e.attempt);
  }

  return { byTier, retries, unattributed };
}
