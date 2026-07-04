import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  compareManifestToSidecars,
  readBuildTaskSidecarRefs,
  type ManifestEntry,
  type SidecarRef,
} from '../../src/core/fanout/file-fanout.js';

// File-level fan-out completeness: the pure comparison the --manifest mode of
// `spin fanout-check` runs. Every design-manifest file must be accounted for by a
// build-task sidecar whose `file` field names it exactly; anything unaccounted is
// a dropped per-file build worker the ledger cannot see.

const m = (file: string): ManifestEntry => ({ file, action: 'create', purpose: 'p' });
const s = (sidecar: string, file: string): SidecarRef => ({ sidecar, file });

describe('compareManifestToSidecars', () => {
  it('passes when every manifest file has a matching sidecar', () => {
    const v = compareManifestToSidecars(
      [m('src/a.ts'), m('src/b.ts')],
      [s('a.json', 'src/a.ts'), s('b.json', 'src/b.ts')]
    );
    expect(v.passed).toBe(true);
    expect(v.expected).toBe(2);
    expect(v.found).toBe(2);
    expect(v.missing).toEqual([]);
    expect(v.unmet).toEqual([]);
  });

  it('reports missing entries verbatim as the re-dispatch list', () => {
    const dropped: ManifestEntry = { file: 'src/c.ts', action: 'modify', purpose: 'wire c' };
    const v = compareManifestToSidecars(
      [m('src/a.ts'), m('src/b.ts'), dropped],
      [s('a.json', 'src/a.ts'), s('b.json', 'src/b.ts')]
    );
    expect(v.passed).toBe(false);
    expect(v.found).toBe(2);
    // the missing[] entry is the FULL manifest row — everything needed to re-dispatch
    expect(v.missing).toEqual([dropped]);
    expect(v.unmet).toEqual(['fanout-missing:src/c.ts']);
    expect(v.reasons[0]).toContain('2/3');
    expect(v.reasons[0]).toContain('src/c.ts');
  });

  it('matches on the exact file string, not on sidecar filenames', () => {
    // sidecar names are orchestrator-chosen; identity is the `file` field
    const v = compareManifestToSidecars([m('src/a.ts')], [s('whatever-99.json', 'src/a.ts')]);
    expect(v.passed).toBe(true);
    expect(v.matched).toEqual([{ file: 'src/a.ts', sidecar: 'whatever-99.json' }]);
  });

  it('flags sidecars for files the manifest never listed as extra (informational, not blocking)', () => {
    const v = compareManifestToSidecars([m('src/a.ts')], [
      s('a.json', 'src/a.ts'),
      s('rogue.json', 'src/rogue.ts'),
    ]);
    expect(v.passed).toBe(true);
    expect(v.extra).toEqual([s('rogue.json', 'src/rogue.ts')]);
  });

  it('tolerates duplicate sidecars claiming the same file', () => {
    const v = compareManifestToSidecars([m('src/a.ts')], [
      s('first.json', 'src/a.ts'),
      s('second.json', 'src/a.ts'),
    ]);
    expect(v.passed).toBe(true);
    expect(v.found).toBe(1);
  });

  it('blocks with every entry missing when no sidecars exist (total drop)', () => {
    const v = compareManifestToSidecars([m('src/a.ts'), m('src/b.ts')], []);
    expect(v.passed).toBe(false);
    expect(v.missing.map((x) => x.file)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(v.unmet).toEqual(['fanout-missing:src/a.ts', 'fanout-missing:src/b.ts']);
  });
});

describe('readBuildTaskSidecarRefs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-sidecars-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const writeJson = (name: string, obj: unknown) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));

  it('collects only sidecars carrying a string `file` field (build-task shape)', () => {
    writeJson('task-a.json', { file: 'src/a.ts', verification_passed: true });
    // sibling sidecars in the same .handoffs/ dir that must NOT count as build-tasks:
    writeJson('define.json', { feature: 'f', clarity: 1, criteria: ['AC-1'] });
    writeJson('design.json', { feature: 'f', manifest: [{ file: 'x', action: 'create', purpose: 'p' }] });
    writeJson('build.json', { feature: 'f', results: [], files_written: [] });
    fs.writeFileSync(path.join(dir, 'notes.md'), 'not json');
    expect(readBuildTaskSidecarRefs(dir)).toEqual([{ sidecar: 'task-a.json', file: 'src/a.ts' }]);
  });

  it('skips unparseable JSON — garbage output cannot account for a unit', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    writeJson('ok.json', { file: 'src/ok.ts' });
    expect(readBuildTaskSidecarRefs(dir)).toEqual([{ sidecar: 'ok.json', file: 'src/ok.ts' }]);
  });

  it('returns an empty list for an empty dir', () => {
    expect(readBuildTaskSidecarRefs(dir)).toEqual([]);
  });
});
