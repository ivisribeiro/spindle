import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // src/commands is counted (handlers.ts is the largest file in the repo — it must
      // not sit in a coverage blind spot). src/cli/index.ts stays excluded: it is
      // commander wiring (arg parsing + one error-code mapping), exercised end-to-end
      // by every test that goes through the cli() helper, but its declarative
      // .command()/.option() chains would only inflate the line count.
      include: ['src/core/**/*.ts', 'src/commands/**/*.ts'],
      exclude: ['src/core/**/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        // Per-file ratchet for the largest file in the repo, set ~5 points below its
        // measured coverage (99.0 stmts / 99.7 lines / 100 funcs / 88.8 branch as of
        // 2026-07) so a regression in the handler exit-code surface fails fast without
        // inviting threshold-gaming. Files matched here leave the global 80 bucket.
        'src/commands/handlers.ts': {
          lines: 94,
          functions: 95,
          statements: 94,
          branches: 83,
        },
      },
    },
  },
});
