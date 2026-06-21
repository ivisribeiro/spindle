#!/usr/bin/env node
// Build the spin CLI into a SINGLE self-contained ESM bundle (deps inlined) so the
// plugin runs offline with no node_modules. Also typechecks with tsc.
// The bundle lands at dist/cli/index.js; bin/spin.js imports it.

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

console.log('Type-checking (tsc --noEmit)...');
try {
  const tscPath = require.resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tscPath, '--noEmit'], { stdio: 'inherit' });
} catch {
  console.error('Type-check failed.');
  process.exit(1);
}

if (existsSync('dist')) rmSync('dist', { recursive: true, force: true });

console.log('Bundling with esbuild...');
await esbuild.build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/cli/index.js',
  // Some bundled CJS deps reference require(); provide it in the ESM bundle.
  banner: {
    js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);",
  },
});

// Sync the self-contained bundle + schemas INTO plugin/ so that, on a real Claude
// Code install, ${CLAUDE_PLUGIN_ROOT} (= plugin/) resolves ${CLAUDE_PLUGIN_ROOT}/dist
// and the CLI finds plugin/schemas/. Without this the plugin's `spin` shorthand
// would point at a non-existent path. (The repo-root dist/ + schemas/ remain for
// npm/vitest.)
console.log('Syncing bundle + schemas into plugin/...');
for (const sub of ['dist', 'schemas']) {
  rmSync(`plugin/${sub}`, { recursive: true, force: true });
  cpSync(sub, `plugin/${sub}`, { recursive: true });
}

console.log('Build completed: dist/cli/index.js (+ plugin/dist, plugin/schemas).');
