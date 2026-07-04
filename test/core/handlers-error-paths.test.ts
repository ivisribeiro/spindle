import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, write, writeJson } from '../helpers.js';

// The usage-error surface of the command handlers — the exit-code ABI's `2` lane.
// Slash commands branch on these codes, so a guard that silently returns the wrong
// code is a control-flow bug in every workflow command. These were the largest
// uncovered branch cluster in handlers.ts when src/commands entered coverage.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('handlers: usage-error paths (exit 2)', () => {
  it('init rejects an unknown bundled schema', async () => {
    const r = await R('init', '--schema', 'nope');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('unknown bundled schema');
  });

  it('every run-state-backed command exits 2 before init (missing ledger = usage, not crash)', async () => {
    // one sweep over the pre-init guards: each must be exit 2 with the same hint
    for (const args of [
      ['state'],
      ['next'],
      ['order'],
      ['budget'],
      ['complete', 'define'],
      ['validate', 'define'],
      ['retry', 'define', '--ok'],
      ['invalidate', 'define'],
      ['approve'],
    ]) {
      const r = await R(...args);
      expect(r.code, `spin ${args.join(' ')} pre-init`).toBe(2);
    }
  });

  it('complete rejects an unknown artifact id', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'e');
    const r = await R('complete', 'ghost');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('unknown artifact');
  });

  it('complete requires --handoff when the artifact declares a handoff schema', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'e');
    const r = await R('complete', 'define');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('--handoff');
  });

  it('merge-findings rejects a missing file, invalid JSON, and a non-array shape', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'e');
    expect((await R('merge-findings', 'ghost.json')).code).toBe(2);

    write(root, 'bad.json', '{ not json');
    expect((await R('merge-findings', 'bad.json')).code).toBe(2);

    writeJson(root, 'notarray.json', { hello: 'world' });
    const r = await R('merge-findings', 'notarray.json');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('findings array');
  });

  it('kb-install rejects a missing source dir with a pointer to /create-kb', async () => {
    const r = await R('kb-install', 'ghost-domain');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('KB source not found');
  });

  it('diff-criteria rejects missing flags, missing files, and non-JSON input', async () => {
    expect((await R('diff-criteria', '--define', 'a.json')).code).toBe(2); // commander: missing required --build
    const d = writeJson(root, 'define.json', { criteria: ['AC-1'] });
    expect((await R('diff-criteria', '--define', d, '--build', `${root}/ghost.json`)).code).toBe(2);
    write(root, 'notjson.md', '# a markdown artifact, not a sidecar');
    const r = await R('diff-criteria', '--define', d, '--build', `${root}/notjson.md`);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('JSON handoff sidecars');
  });

  it('tier rejects a bad --breadth enum', async () => {
    const r = await R('tier', '--breadth', 'huge');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('--breadth');
  });

  it('schema show/validate exit 2 before init; unknown action exits 2', async () => {
    expect((await R('schema', 'show')).code).toBe(2);
    expect((await R('schema', 'validate')).code).toBe(2);
    await R('init', '--schema', 'sdd', '--feature', 'e');
    expect((await R('schema', 'show')).code).toBe(0); // full schema dump after init
    const r = await R('schema', 'destroy');
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('unknown schema action');
  });

  it('reconcile rejects a missing --audit file and invalid JSON', async () => {
    expect((await R('reconcile', '--audit', 'ghost.json')).code).toBe(2);
    write(root, 'bad.json', '{ nope');
    expect((await R('reconcile', '--audit', 'bad.json')).code).toBe(2);
  });

  it('spec-drift rejects a missing build report and invalid JSON', async () => {
    expect((await R('spec-drift', '--build', 'ghost.json')).code).toBe(2);
    write(root, 'bad.json', '{ nope');
    expect((await R('spec-drift', '--build', 'bad.json')).code).toBe(2);
  });
});

describe('handlers: schema-mismatch domain blocks (exit 1)', () => {
  it('reconcile blocks (exit 1) when the audit does not match the audit schema', async () => {
    // an invalid status enum in built[] fails the AuditHandoff Zod schema
    const f = writeJson(root, 'aud.json', {
      domain: 'd',
      built: [{ item: 'x', evidence: {}, status: 'vibes' }],
    });
    const r = await R('reconcile', '--audit', f);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain('AuditHandoff');
  });

  it('spec-drift blocks (exit 1) when the report does not match the build-report schema', async () => {
    const f = writeJson(root, 'br.json', { results: 'not-an-array' });
    const r = await R('spec-drift', '--build', f);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain('BuildReportHandoff');
  });

  it('validate blocks (exit 1) on a plain path that does not exist', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'e');
    const r = await R('validate', 'no/such/file.md');
    expect(r.code).toBe(1);
    expect(r.json.issues).toContain('file not found');
  });

  it('validate flags a DESIGN.md missing its file-manifest table', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'e');
    write(
      root,
      '.spindle/features/e/DESIGN.md',
      '## Overview\nx\n## File Manifest\nprose, no table\n## Decisions\ny\n'
    );
    const r = await R('validate', 'design');
    expect(r.code).toBe(1);
    expect(JSON.stringify(r.json.issues)).toContain('file-manifest table');
  });
});
