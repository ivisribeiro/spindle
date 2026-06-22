#!/usr/bin/env bash
# SessionEnd hook. If this project has an active spindle run, surface the run-ledger
# summary (spin trace) so the operator sees what the harness recorded — phases
# completed, gate verdicts, retries, and reported tier/token spend. Pure read; the
# CLI never calls a model. Fail-open: never block or error a session.
set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# No active run in this project -> nothing to surface.
[ -f ".spindle/run.json" ] || exit 0

# Locate the prebuilt bundle (alongside the plugin when packaged, one level up in dev).
CLI=""
for candidate in "$ROOT/dist/cli/index.js" "$ROOT/../dist/cli/index.js"; do
  if [ -f "$candidate" ]; then
    CLI="$candidate"
    break
  fi
done
[ -n "$CLI" ] || exit 0

node "$CLI" trace 2>/dev/null || true
exit 0
