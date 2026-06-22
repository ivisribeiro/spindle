#!/usr/bin/env bash
# Spindle's NATIVE cross-vendor reviewer. Invokes the codex (OpenAI) CLI directly to get
# an independent review of the current work — no third-party Claude plugin required. The
# /codex-review command adapts this output into a `finding` sidecar that the deterministic
# G_REVIEW_BLOCK gate judges. This lives on the MODEL side (a script a command runs); the
# spin spine in src/ never calls a model, so the harness-purity invariant is preserved.
#
# Usage: codex-review.sh [target]
#   target — a path/dir to review, or "diff" (default) to review the current git diff.
# Output: codex's raw review on stdout (expected to be a JSON array of findings).
# Fail-open: if the codex CLI is absent or errors, print a marker and exit 0 — a missing
# cross-vendor reviewer must never block the run; the Claude-side adversarial gate still runs.
set -uo pipefail

TARGET="${1:-diff}"

if ! command -v codex >/dev/null 2>&1; then
  echo "CODEX_UNAVAILABLE: the codex CLI is not on PATH. Install it and run 'codex login'"
  echo "to enable Spindle's native cross-vendor review. Skipping (the Claude-side review still runs)."
  exit 0
fi

read -r -d '' PROMPT <<EOF || true
You are an independent cross-vendor code reviewer. Review ${TARGET} (if it is "diff",
review the current git diff) for correctness bugs, security vulnerabilities, and design
flaws. Be adversarial: try to find what is wrong, not what is fine.

Output ONLY a JSON array. Each element MUST be:
  {"severity":"critical|high|medium|low","file":"<repo-relative path>","line":<int or null>,"rule":"<short category>","message":"<evidence-grounded explanation>"}
Use "critical" only for a defect that must block the merge. Emit [] if you find nothing.
No prose, no markdown fences — just the JSON array.
EOF

# codex exec is the non-interactive one-shot mode. It selects its model + auth via
# `codex login`; Spindle does not hardcode a model id or an endpoint.
codex exec "$PROMPT" 2>&1 || echo "CODEX_ERROR: codex exec failed (check 'codex login')."
exit 0
