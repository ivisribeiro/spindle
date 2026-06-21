#!/usr/bin/env bash
# SessionStart hook. Ensures the spin CLI bundle is present. The plugin ships a
# prebuilt self-contained bundle (dist/cli/index.js, deps inlined) so this is
# normally a no-op. If the bundle is missing AND a dev toolchain is available,
# it rebuilds quietly. It NEVER calls a model and NEVER runs `spin init` (that is
# per-feature and user-driven). Fail-open: never block a session.
set -euo pipefail

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# The bundle lives one level up from plugin/ (repo root)/dist when developing,
# or alongside the plugin when packaged. Probe both.
for candidate in "$ROOT/../dist/cli/index.js" "$ROOT/dist/cli/index.js"; do
  if [ -f "$candidate" ]; then
    exit 0
  fi
done

# Bundle missing — attempt a quiet rebuild only if the toolchain is present.
REPO="$ROOT/.."
if [ -f "$REPO/build.js" ] && [ -d "$REPO/node_modules" ]; then
  ( cd "$REPO" && node build.js >/dev/null 2>&1 ) || true
fi
exit 0
