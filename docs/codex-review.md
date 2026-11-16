# Cross-vendor review (codex) — setup, auth, config

Spindle can run an independent review from a different vendor — the codex (OpenAI) CLI —
and feed its findings into the same `G_REVIEW_BLOCK` gate that judges the Claude-side
critics. A different vendor judging the code Claude wrote is the strongest form of
"the verifier is not the generator." It is an **extra, optional step**, run only when
warranted (high-stakes / T2 work); it changes nothing in the normal `/review` or build
flow, and it is **fail-open** — if it is not set up, the command reports a skip and you
fall back to `/review`.

The codex call lives entirely on the model side (`scripts/codex-review.sh`, invoked by the
`/codex-review` command). The `spin` spine never calls a model, and Spindle stores no
credentials.

## 1. Install the codex CLI

```bash
npm install -g @openai/codex      # or your platform's codex install
codex --version                   # confirm it is on PATH
```

## 2. Authenticate (pick one — Spindle stores no secret)

- **ChatGPT login** (incl. Free):
  ```bash
  codex login
  ```
- **OpenAI API key** — set `OPENAI_API_KEY` in the env, or in the per-project config file
  below. Never commit it.

## 3. Config — `.spindle/codex.env` (optional, gitignored)

Keep this file ignored in your project and create it yourself. The helper reads
it as shell configuration, so use a file you trust. An API key can stay in the
process environment. Example configuration:

```bash
# .spindle/codex.env  — per-project codex review config (DO NOT COMMIT)

# Auth (only if you are not using `codex login`):
# OPENAI_API_KEY=sk-...

# Knobs (all optional):
SPINDLE_CODEX_ENABLED=1        # set 0 to turn the cross-vendor step off entirely
# SPINDLE_CODEX_MODEL=         # optional model id, passed as: codex exec -m <model>
# SPINDLE_CODEX_FLAGS=         # optional extra flags for `codex exec`
```

You can also set any of these as plain environment variables instead of using the file.

## 4. Use it

```bash
/codex-review            # review the current diff
/codex-review src/auth   # scope to a path
```

It runs `scripts/codex-review.sh` with a read-only Codex sandbox and adapts a valid JSON array into a `finding` sidecar
(`source: codex`), and lets `spin gate G_REVIEW_BLOCK` decide. The gate is the judge of
record — never codex's own stop behavior.

## Markers (fail-open)

The helper never blocks; on any unmet precondition it prints a marker and exits 0, and you
fall back to `/review`. Empty or malformed responses also use the fallback. An
actual JSON `[]` records a successful review with zero findings.

| Marker | Meaning | Fix |
|---|---|---|
| `CODEX_DISABLED` | `SPINDLE_CODEX_ENABLED=0` | set it to `1` |
| `CODEX_UNAVAILABLE` | codex CLI not on PATH | install the codex CLI |
| `CODEX_ERROR` | codex ran but failed (usually auth) | `codex login` or set `OPENAI_API_KEY` |

## Security

- No credential is ever stored in the repo or in `plugin/`. The key lives only in your env
  or in `.spindle/codex.env` (gitignored).
- The codex invocation is model-side; `src/` stays pure (the model-free guard enforces it).
- This is one independent reviewer that raises the bar — not a proof of correctness.

## Verified end-to-end

Proven against a real codex CLI (`codex-cli 0.141.0`, model `gpt-5.5`): given a file with a
planted SQL injection + hardcoded secret, codex returned a clean JSON finding array flagging
the injection as `critical`. Adapted into a `source: codex` sidecar, it fed `spin gate
G_REVIEW_BLOCK`, which **blocked** on the surviving CRITICAL (and `--min-sources 2` blocked
with `insufficient-sources`, the independence floor). The deterministic gate — not codex — is
the judge of record.
