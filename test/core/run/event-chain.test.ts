import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canonicalEventContent,
  computeEventHash,
  hashNewEvent,
  verifyEventChain,
} from '../../../src/core/run/event-chain.js';
import type { RunEvent } from '../../../src/core/run/run-state.schema.js';
import {
  initRunState,
  loadRunState,
  markComplete,
  markApproved,
  recordGate,
  incRetry,
  runFilePath,
  atomicWrite,
} from '../../../src/core/run/run-state.js';

// --- pure function tests -----------------------------------------------

describe('event-chain: canonicalization', () => {
  it('is stable under key-insertion order', () => {
    const a = { kind: 'retry', at: 't', id: 'build', attempt: 1 } as RunEvent;
    const b = { attempt: 1, id: 'build', at: 't', kind: 'retry' } as unknown as RunEvent;
    expect(canonicalEventContent(a)).toBe(canonicalEventContent(b));
  });

  it('excludes the hash field itself from the canonical content', () => {
    const withoutHash = { kind: 'retry', at: 't', id: 'build', attempt: 1 } as RunEvent;
    const withHash = { ...withoutHash, hash: 'whatever' } as unknown as RunEvent;
    expect(canonicalEventContent(withHash)).toBe(canonicalEventContent(withoutHash));
  });

  it('does not reorder array contents (order is semantic)', () => {
    const a = { kind: 'gate', at: 't', gate: 'G_BUILD', passed: false, reasons: ['x', 'y'] } as RunEvent;
    const b = { kind: 'gate', at: 't', gate: 'G_BUILD', passed: false, reasons: ['y', 'x'] } as RunEvent;
    expect(canonicalEventContent(a)).not.toBe(canonicalEventContent(b));
  });
});

describe('event-chain: computeEventHash', () => {
  const event = { kind: 'retry', at: 't', id: 'build', attempt: 1 } as RunEvent;

  it('is deterministic for the same event + prevHash', () => {
    expect(computeEventHash(event, null)).toBe(computeEventHash(event, null));
  });

  it('changes when the event content changes', () => {
    const other = { ...event, attempt: 2 } as RunEvent;
    expect(computeEventHash(event, null)).not.toBe(computeEventHash(other, null));
  });

  it('changes when prevHash changes (chains link to their predecessor)', () => {
    expect(computeEventHash(event, null)).not.toBe(computeEventHash(event, 'some-prev-hash'));
  });

  it('produces a 64-char lowercase hex sha256 digest', () => {
    const h = computeEventHash(event, null);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('event-chain: hashNewEvent + verifyEventChain (pure)', () => {
  it('an empty ledger verifies trivially (0 verified, 0 legacy)', () => {
    const result = verifyEventChain([]);
    expect(result).toEqual({ ok: true, verified: 0, legacy: 0 });
  });

  it('chains N events sequentially and verifies intact', () => {
    let events: RunEvent[] = [];
    for (let i = 1; i <= 4; i++) {
      const e = { kind: 'retry', at: `t${i}`, id: 'build', attempt: i } as RunEvent;
      events = [...events, hashNewEvent(events, e)];
    }
    const result = verifyEventChain(events);
    expect(result).toEqual({ ok: true, verified: 4, legacy: 0 });
  });

  it('the first hashed event starts fresh (prevHash = null)', () => {
    const e = { kind: 'retry', at: 't1', id: 'build', attempt: 1 } as RunEvent;
    const hashed = hashNewEvent([], e);
    expect((hashed as RunEvent & { hash: string }).hash).toBe(computeEventHash(e, null));
  });

  it('detects a tampered event content (hash mismatch) and names the index', () => {
    let events: RunEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      const e = { kind: 'retry', at: `t${i}`, id: 'build', attempt: i } as RunEvent;
      events = [...events, hashNewEvent(events, e)];
    }
    // Tamper with the middle event's content without recomputing its hash.
    const tampered = events.map((e, i) =>
      i === 1 ? ({ ...e, attempt: 999 } as RunEvent) : e
    );
    const result = verifyEventChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.brokenAt).toBe(1);
      expect(result.verified).toBe(1); // index 0 verified fine before the break
      expect(result.reason).toContain('index 1');
    }
  });

  it('detects a stripped hash appearing after the chain started', () => {
    let events: RunEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      const e = { kind: 'retry', at: `t${i}`, id: 'build', attempt: i } as RunEvent;
      events = [...events, hashNewEvent(events, e)];
    }
    const stripped = events.map((e, i) => {
      if (i !== 2) return e;
      const { hash: _drop, ...rest } = e as RunEvent & { hash?: string };
      return rest as RunEvent;
    });
    const result = verifyEventChain(stripped);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(2);
  });

  it('treats a run of unhashed events as a legacy PREFIX (no break)', () => {
    const legacy: RunEvent[] = [
      { kind: 'retry', at: 't1', id: 'build', attempt: 1 },
      { kind: 'retry', at: 't2', id: 'build', attempt: 2 },
    ];
    const result = verifyEventChain(legacy);
    expect(result).toEqual({ ok: true, verified: 0, legacy: 2 });
  });

  it('a legacy prefix followed by a hashed suffix verifies with both counts', () => {
    const legacy: RunEvent[] = [{ kind: 'retry', at: 't0', id: 'old', attempt: 1 }];
    // Appending fresh (hashed) events after a legacy prefix starts the chain fresh.
    let events = legacy;
    const e2 = { kind: 'retry', at: 't1', id: 'build', attempt: 1 } as RunEvent;
    events = [...events, hashNewEvent(events, e2)];
    const e3 = { kind: 'retry', at: 't2', id: 'build', attempt: 2 } as RunEvent;
    events = [...events, hashNewEvent(events, e3)];

    const result = verifyEventChain(events);
    expect(result).toEqual({ ok: true, verified: 2, legacy: 1 });
  });
});

// --- integration through run-state.ts mutation points -------------------

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-chain-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('event-chain: integration via run-state.ts', () => {
  it('every event appended through the real mutation points carries a hash and verifies intact', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define', { tier: 'sonnet', tokens_in: 10, tokens_out: 5 });
    recordGate(root, 'G_DEFINE', { passed: true, reasons: [] });
    incRetry(root, 'build');
    markApproved(root, 'ivis', { version: 1, files: [{ path: 'file', sha256: '0'.repeat(64) }] });

    const state = loadRunState(root);
    expect(state.events.length).toBe(4);
    for (const e of state.events) {
      expect((e as RunEvent & { hash?: string }).hash).toBeTruthy();
    }
    const result = verifyEventChain(state.events);
    expect(result).toEqual({ ok: true, verified: 4, legacy: 0 });
  });

  it('idempotent re-run (unchanged gate / already-complete id) appends no event and keeps the chain intact', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define');
    recordGate(root, 'G_DEFINE', { passed: false, reasons: ['x'] });

    const before = loadRunState(root).events;
    expect(before.length).toBe(2);

    // Re-running with an identical outcome must NOT append (dedup ignores hash/prev).
    markComplete(root, 'define'); // already completed
    recordGate(root, 'G_DEFINE', { passed: false, reasons: ['x'] }); // identical verdict

    const after = loadRunState(root).events;
    expect(after.length).toBe(2);
    expect(after).toEqual(before);
    expect(verifyEventChain(after)).toEqual({ ok: true, verified: 2, legacy: 0 });
  });

  it('detects a hand-tampered run.json (mutated event field) — names the broken index', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define');
    markComplete(root, 'design');

    const file = runFilePath(root);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.events[0].id = 'tampered-id'; // mutate content without recomputing hash
    atomicWrite(file, JSON.stringify(raw, null, 2) + '\n');

    const state = loadRunState(root);
    const result = verifyEventChain(state.events);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(0);
  });

  it('a hand-written legacy ledger (no hash fields) is accepted, and new events chain fresh on top', () => {
    const ts = new Date().toISOString();
    const legacyState = {
      version: 1,
      schema: 'sdd',
      feature: 'feat',
      completed: ['define'],
      retries: {},
      gates: {},
      events: [
        { kind: 'complete', at: ts, id: 'define' }, // no hash — legacy
      ],
      approval: null,
      createdAt: ts,
      updatedAt: ts,
    };
    fs.mkdirSync(path.dirname(runFilePath(root)), { recursive: true });
    atomicWrite(runFilePath(root), JSON.stringify(legacyState, null, 2) + '\n');

    // Confirms the legacy file loads fine (schema treats `hash` as optional).
    expect(loadRunState(root).events.length).toBe(1);

    // Append a new event on top of the legacy ledger.
    incRetry(root, 'build');

    const events = loadRunState(root).events;
    expect(events.length).toBe(2);
    const result = verifyEventChain(events);
    expect(result).toEqual({ ok: true, verified: 1, legacy: 1 });
  });
});
