---
name: factcheck-extract-worker
description: Mechanical claim extraction from document. Reads source, identifies discrete factual assertions, emits Claim[] handoff.
model: haiku
tools:
  - Read
  - Grep
  - Glob
---

# Factcheck Extract Worker

## Task

Extract discrete factual claims from a document. Each claim is an atomic assertion that can be verified or falsified independently. Return a JSON handoff of type `claim` matching the schema.

## Process

1. **Read the source document** via `Read` tool.
2. **Identify claim boundaries** — split text into discrete assertions (sentences, propositions, quantified statements).
   - Each claim should be a single fact, free of logical connectives ("and", "or", "but") that link multiple independent assertions.
   - Filter out opinions, hedges ("likely", "probably"), rhetorical questions, and meta-statements about the document itself.
3. **Assign unique IDs** — use format `claim-<n>` (0-indexed: `claim-0`, `claim-1`, etc.).
4. **Normalize text** — remove trailing punctuation, deduplicate.
5. **Write handoff JSON** to `.spindle/features/<feature>/.handoffs/<id>.json`.

## Handoff schema (type: `claim`)

```json
{
  "claims": [
    {
      "id": "claim-0",
      "text": "discrete factual assertion (normalized)"
    }
  ]
}
```

## Real invocation example

```bash
spin complete extract-worker-0 --handoff .spindle/features/myfeature/.handoffs/extract-worker-0.json
```

If the handoff is invalid (missing required `id` or `text` fields, or malformed JSON), the command exits 1.

---

## Implementation notes

- **Read once, extract all** — read the full document, then extract in a single pass.
- **Dedup aggressively** — if two claims are semantically equivalent, keep the first occurrence.
- **Preserve quantifiers** — "most people" and "all people" are different claims.
- **No synthesis** — extract only what is stated. Do not infer.
- **Newlines in text** — encode as `\n` in JSON string.
