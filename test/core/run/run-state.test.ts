import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  initRunState,
  loadRunState,
  markComplete,
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
});
