import { describe, it, expect } from 'vitest';
import { aggregateUsageStats } from '../../../src/core/model-route/usage-stats.js';
import type { RunEvent } from '../../../src/core/run/run-state.schema.js';

describe('aggregateUsageStats', () => {
  it('returns all-zero buckets, no retries, and 0 unattributed on an empty ledger', () => {
    const stats = aggregateUsageStats([]);
    expect(stats).toEqual({
      byTier: {
        haiku: { completions: 0, tokens_in: 0, tokens_out: 0 },
        sonnet: { completions: 0, tokens_in: 0, tokens_out: 0 },
        opus: { completions: 0, tokens_in: 0, tokens_out: 0 },
      },
      retries: {},
      unattributed: 0,
    });
  });

  it('sums completions and tokens per known tier', () => {
    const events: RunEvent[] = [
      { kind: 'complete', at: 't1', id: 'define', usage: { tier: 'sonnet', tokens_in: 100, tokens_out: 40 } },
      { kind: 'complete', at: 't2', id: 'design', usage: { tier: 'sonnet', tokens_in: 20, tokens_out: 10 } },
      { kind: 'complete', at: 't3', id: 'build', usage: { tier: 'opus', tokens_in: 5, tokens_out: 5 } },
    ];
    const stats = aggregateUsageStats(events);
    expect(stats.byTier.sonnet).toEqual({ completions: 2, tokens_in: 120, tokens_out: 50 });
    expect(stats.byTier.opus).toEqual({ completions: 1, tokens_in: 5, tokens_out: 5 });
    expect(stats.byTier.haiku).toEqual({ completions: 0, tokens_in: 0, tokens_out: 0 });
    expect(stats.unattributed).toBe(0);
  });

  it('counts a completion with no usage, or an unrecognized tier, as unattributed', () => {
    const events: RunEvent[] = [
      { kind: 'complete', at: 't1', id: 'define' }, // no usage at all
      { kind: 'complete', at: 't2', id: 'design', usage: { tier: 'gpt5' } as never }, // unknown tier
    ];
    const stats = aggregateUsageStats(events);
    expect(stats.unattributed).toBe(2);
    expect(stats.byTier.haiku.completions).toBe(0);
    expect(stats.byTier.sonnet.completions).toBe(0);
    expect(stats.byTier.opus.completions).toBe(0);
  });

  it('does not double count tokens when only one of tokens_in/tokens_out is reported', () => {
    const events: RunEvent[] = [
      { kind: 'complete', at: 't1', id: 'define', usage: { tier: 'haiku', tokens_in: 30 } },
    ];
    const stats = aggregateUsageStats(events);
    expect(stats.byTier.haiku).toEqual({ completions: 1, tokens_in: 30, tokens_out: 0 });
  });

  it('tracks the latest (max) attempt per artifact from retry events', () => {
    const events: RunEvent[] = [
      { kind: 'retry', at: 't1', id: 'build', attempt: 1 },
      { kind: 'retry', at: 't2', id: 'build', attempt: 2 },
      { kind: 'retry', at: 't3', id: 'design', attempt: 1 },
    ];
    const stats = aggregateUsageStats(events);
    expect(stats.retries).toEqual({ build: 2, design: 1 });
  });

  it('ignores gate and approve events entirely', () => {
    const events: RunEvent[] = [
      { kind: 'gate', at: 't1', gate: 'G_DEFINE', passed: true, reasons: [] },
      { kind: 'approve', at: 't2', by: 'ivis' },
    ];
    const stats = aggregateUsageStats(events);
    expect(stats.unattributed).toBe(0);
    expect(stats.retries).toEqual({});
  });
});
