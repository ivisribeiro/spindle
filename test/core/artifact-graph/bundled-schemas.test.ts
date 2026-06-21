import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema } from '../../../src/core/artifact-graph/schema.js';

// Guards against shipping a malformed bundled workflow schema (e.g. an unquoted
// colon in a description, or a dependency cycle). `spin init --schema <x>` loads
// these, so a bad one breaks the whole workflow — this test catches it in CI.

const SCHEMAS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'schemas'
);

function bundledSchemaFiles(): string[] {
  return fs
    .readdirSync(SCHEMAS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(SCHEMAS_DIR, e.name, 'schema.yaml'))
    .filter((p) => fs.existsSync(p));
}

describe('every bundled schema is valid', () => {
  const files = bundledSchemaFiles();

  it('discovers at least the sdd and kb schemas', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(files)('loads and validates %s', (file) => {
    expect(() => loadSchema(file)).not.toThrow();
    const schema = loadSchema(file);
    expect(schema.artifacts.length).toBeGreaterThan(0);
  });
});
