#!/usr/bin/env node
// spin CLI entrypoint. Runs the compiled dist/ build.
// The plugin ships prebuilt dist/ so this works offline with no npm install.
import { runCli } from '../dist/cli/index.js';

runCli(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err?.stack || String(err));
    process.exit(3);
  }
);
