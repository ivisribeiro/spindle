import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initRunState,
  loadRunState,
  markComplete,
  markApproved,
  markIncomplete,
  incRetry,
  getRetry,
  recordGate,
  runStateExists,
  RunStateError,
} from '../../../src/core/run/run-state.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-rs-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('run-state ledger', () => {
  it('initializes and round-trips', () => {
    const s = initRunState(root, 'sdd', 'feat');
    expect(s.schema).toBe('sdd');
    expect(s.feature).toBe('feat');
    expect(runStateExists(root)).toBe(true);
    expect(loadRunState(root).feature).toBe('feat');
  });

  it('marks complete idempotently and keeps the set sorted+unique', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'design');
    markComplete(root, 'define');
    markComplete(root, 'define'); // duplicate
    expect(loadRunState(root).completed).toEqual(['define', 'design']);
  });

  it('drops completion on markIncomplete (re-gating)', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define');
    markComplete(root, 'design');
    markIncomplete(root, ['design']);
    expect(loadRunState(root).completed).toEqual(['define']);
  });

  it('increments retry counters', () => {
    initRunState(root, 'sdd', 'feat');
    expect(getRetry(root, 'build')).toBe(0);
    expect(incRetry(root, 'build')).toBe(1);
    expect(incRetry(root, 'build')).toBe(2);
    expect(getRetry(root, 'build')).toBe(2);
  });

  it('records gate verdicts in the ledger', () => {
    initRunState(root, 'sdd', 'feat');
    recordGate(root, 'G_DEFINE', { passed: true, reasons: ['ok'] });
    const s = loadRunState(root);
    expect(s.gates.G_DEFINE.passed).toBe(true);
    expect(s.gates.G_DEFINE.at).toBeTruthy();
  });

  it('throws on a missing or corrupt ledger', () => {
    expect(() => loadRunState(root)).toThrow(RunStateError);
    fs.mkdirSync(path.join(root, '.spindle'), { recursive: true });
    fs.writeFileSync(path.join(root, '.spindle', 'run.json'), '{ not json');
    expect(() => loadRunState(root)).toThrow(RunStateError);
  });

  it('is crash-safe: reload yields the identical ledger', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define');
    incRetry(root, 'build');
    const a = JSON.stringify({ ...loadRunState(root), updatedAt: '' });
    const b = JSON.stringify({ ...loadRunState(root), updatedAt: '' });
    expect(a).toBe(b);
  });

  // --- run-ledger events[] (Measured Harness, Fase 1) ---

  it('appends a complete event only when newly completed (idempotent ledger)', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define');
    markComplete(root, 'define'); // duplicate — no second event
    const ev = loadRunState(root).events.filter((e) => e.kind === 'complete');
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ kind: 'complete', id: 'define' });
  });

  it('records opaque model-reported usage on the complete event', () => {
    initRunState(root, 'sdd', 'feat');
    markComplete(root, 'define', { tier: 'opus', tokens_in: 10, tokens_out: 5 });
    const ev = loadRunState(root).events.find((e) => e.kind === 'complete');
    expect((ev as { usage?: unknown }).usage).toEqual({ tier: 'opus', tokens_in: 10, tokens_out: 5 });
  });

  it('appends a retry event per increment (full trajectory)', () => {
    initRunState(root, 'sdd', 'feat');
    incRetry(root, 'build');
    incRetry(root, 'build');
    const ev = loadRunState(root).events.filter((e) => e.kind === 'retry');
    expect(ev.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
  });

  it('appends a gate event only when the verdict changes (deduped trajectory)', () => {
    initRunState(root, 'sdd', 'feat');
    recordGate(root, 'G_BUILD', { passed: false, reasons: ['x'] });
    recordGate(root, 'G_BUILD', { passed: false, reasons: ['x'] }); // identical → no new event
    recordGate(root, 'G_BUILD', { passed: true, reasons: [] }); // changed → new event
    const ev = loadRunState(root).events.filter((e) => e.kind === 'gate');
    expect(ev.map((e) => (e as { passed: boolean }).passed)).toEqual([false, true]);
  });

  it('records human approval + an approve event; re-gate (markIncomplete) clears it', () => {
    initRunState(root, 'sdd', 'feat');
    expect(loadRunState(root).approval).toBe(null);
    markApproved(root, 'ivis');
    let s = loadRunState(root);
    expect(s.approval?.by).toBe('ivis');
    expect(s.events.some((e) => e.kind === 'approve')).toBe(true);
    markComplete(root, 'design');
    markIncomplete(root, ['design']); // work changed since approval → approval is stale
    s = loadRunState(root);
    expect(s.approval).toBe(null);
  });
});
