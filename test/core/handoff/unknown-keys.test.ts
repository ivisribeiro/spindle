import { describe, it, expect } from 'vitest';
import { findUnknownKeys } from '../../../src/core/handoff/unknown-keys.js';
import { HANDOFF_SCHEMAS } from '../../../src/core/handoff/schemas.js';

describe('findUnknownKeys (P2: unknown-key visibility on non-strict Zod objects)', () => {
  it('returns [] when every top-level key is recognized', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS.define, {
      feature: 'auth',
      clarity: 0.9,
      criteria: ['AC-1'],
      open_questions: [],
    });
    expect(keys).toEqual([]);
  });

  it('names a typo\'d top-level key that the schema silently strips', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS['build-report'], {
      feature: 'auth',
      results: [],
      files_writen: ['a.ts'], // typo of files_written
    });
    expect(keys).toEqual(['files_writen']);
  });

  it('names multiple unknown top-level keys, in encounter order', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS.define, {
      feature: 'auth',
      clarity: 0.9,
      criteria: ['AC-1'],
      extra_one: true,
      extra_two: 'x',
    });
    expect(keys).toEqual(['extra_one', 'extra_two']);
  });

  it('recurses one level into an array-of-object field and reports the index path', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS['build-report'], {
      feature: 'auth',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
        { criterion: 'AC-3', pased: true }, // typo of "status"
      ],
    });
    expect(keys).toEqual(['results[2].pased']);
  });

  it('reports both a top-level typo and a nested one together', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS.design, {
      feature: 'auth',
      manifest: [{ file: 'a.ts', action: 'create', purpose: 'x', prupose: 'dup typo' }],
      decisons: ['typo of decisions'],
    });
    expect(keys).toEqual(['decisons', 'manifest[0].prupose']);
  });

  it('does not special-case legitimate extension keys — it reports kb-concept stale_since too', () => {
    // /update-kb legitimately writes `stale_since` on a kb-concept sidecar. This is
    // advisory-only, so surfacing it is harmless — the point is NOT to special-case
    // any particular key, just report deterministically.
    const keys = findUnknownKeys(HANDOFF_SCHEMAS['kb-concept'], {
      concept: 'c',
      summary: 's',
      stale_since: '2026-01-01',
    });
    expect(keys).toEqual(['stale_since']);
  });

  it('ignores array items that are not plain objects', () => {
    const keys = findUnknownKeys(HANDOFF_SCHEMAS.define, {
      feature: 'auth',
      clarity: 0.9,
      criteria: ['AC-1'],
    });
    expect(keys).toEqual([]);
  });

  it('returns [] for non-object input', () => {
    expect(findUnknownKeys(HANDOFF_SCHEMAS.define, null)).toEqual([]);
    expect(findUnknownKeys(HANDOFF_SCHEMAS.define, ['a'])).toEqual([]);
    expect(findUnknownKeys(HANDOFF_SCHEMAS.define, 'nope')).toEqual([]);
  });
});
