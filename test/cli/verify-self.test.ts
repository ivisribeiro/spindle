import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { cli, tmpProject, write, writeJson } from '../helpers.js';

// `spin verify-self` — a dist-integrity witness. Recomputes sha256 over the
// files listed in verification/checksums.json and compares. Exit 0 all match,
// exit 1 names mismatched/missing files, exit 2 when the manifest is absent.

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

const DIST_CONTENT = 'export function run() { return 0; }\n';
const PLUGIN_DIST_CONTENT = 'export function run() { return 0; } // plugin copy\n';
const SCHEMA_CONTENT = 'name: sdd\nversion: 1\n';
const PLUGIN_SCHEMA_CONTENT = 'name: sdd\nversion: 1\n';

let root: string;
beforeEach(() => {
  root = tmpProject();
  write(root, 'dist/cli/index.js', DIST_CONTENT);
  write(root, 'plugin/dist/cli/index.js', PLUGIN_DIST_CONTENT);
  write(root, 'schemas/sdd/schema.yaml', SCHEMA_CONTENT);
  write(root, 'plugin/schemas/sdd/schema.yaml', PLUGIN_SCHEMA_CONTENT);
  writeJson(root, 'verification/checksums.json', {
    note: 'test fixture',
    files: {
      'dist/cli/index.js': sha256(DIST_CONTENT),
      'plugin/dist/cli/index.js': sha256(PLUGIN_DIST_CONTENT),
      'schemas/sdd/schema.yaml': sha256(SCHEMA_CONTENT),
      'plugin/schemas/sdd/schema.yaml': sha256(PLUGIN_SCHEMA_CONTENT),
    },
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('spin verify-self', () => {
  it('passes (exit 0) when every file matches the manifest — fresh build', async () => {
    const r = await cli(['--root', root, 'verify-self']);
    expect(r.code).toBe(0);
    expect(r.json.passed).toBe(true);
    expect(r.json.checked).toBe(4);
    expect(r.json.mismatched).toEqual([]);
    expect(r.json.missing).toEqual([]);
    expect(r.json.matched.sort()).toEqual(
      [
        'dist/cli/index.js',
        'plugin/dist/cli/index.js',
        'schemas/sdd/schema.yaml',
        'plugin/schemas/sdd/schema.yaml',
      ].sort()
    );
  });

  it('fails (exit 1) and names a hand-edited dist file (tamper)', async () => {
    // Simulate exactly the invariant violation this exists to catch: dist is
    // BUILD OUTPUT, never hand-edited.
    write(root, 'dist/cli/index.js', DIST_CONTENT + '// hand-edited\n');
    const r = await cli(['--root', root, 'verify-self']);
    expect(r.code).toBe(1);
    expect(r.json.passed).toBe(false);
    expect(r.json.mismatched).toEqual(['dist/cli/index.js']);
    expect(r.json.missing).toEqual([]);
  });

  it('fails (exit 1) and lists a schema file removed since the build (missing)', async () => {
    fs.rmSync(`${root}/plugin/schemas/sdd/schema.yaml`);
    const r = await cli(['--root', root, 'verify-self']);
    expect(r.code).toBe(1);
    expect(r.json.missing).toEqual(['plugin/schemas/sdd/schema.yaml']);
    expect(r.json.mismatched).toEqual([]);
  });

  it('exits 2 when the checksum manifest itself is absent — cannot verify without a build', async () => {
    fs.rmSync(`${root}/verification/checksums.json`);
    const r = await cli(['--root', root, 'verify-self']);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('checksum manifest not found');
  });

  it('honors --manifest to point at an alternate checksum file', async () => {
    writeJson(root, 'alt-checksums.json', {
      files: { 'dist/cli/index.js': sha256(DIST_CONTENT) },
    });
    const r = await cli(['--root', root, 'verify-self', '--manifest', 'alt-checksums.json']);
    expect(r.code).toBe(0);
    expect(r.json.checked).toBe(1);
  });
});
