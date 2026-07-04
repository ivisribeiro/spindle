# Spindle Commands

**30 slash commands** for the SDD workflow, knowledge base, review, visualization, and developer productivity.

## Workflow Commands (7)

| Command | Phase | Description |
|---------|-------|-------------|
| `/brainstorm` | 0 | Explore ideas through dialogue |
| `/define` | 1 | Capture requirements |
| `/design` | 2 | Create architecture |
| `/build` | 3 | Execute implementation |
| `/ship` | 4 | Archive completed feature |
| `/iterate` | Any | Update documents mid-stream |
| `/create-pr` | Any | Create pull request |

## Data Engineering Commands (1)

| Command | Description | Workers |
|---------|-------------|---------|
| `/migrate` | Legacy ETL migration with equivalence proof | migrate-dbt-worker / migrate-spark-worker / equivalence-worker |

> The other data-engineering commands (`/pipeline`, `/schema`, `/data-quality`,
> `/lakehouse`, `/sql-review`, `/ai-pipeline`, `/data-contract`) were thin delegators to
> domain specialists; they now live in the optional `packs/` bundle.

## Core Commands (8)

| Command | Description |
|---------|-------------|
| `/audit` | Brownfield audit → define/design |
| `/gen-router` | Regenerate the agent routing table |
| `/spin` | Run the spin CLI directly |
| `/status` | Project status report (health, SDD state, recommendations) |
| `/sync-context` | Update CLAUDE.md |
| `/meeting` | Meeting transcript analysis |
| `/memory` | Save session insights |
| `/readme-maker` | Generate README |

## Knowledge Commands (3)

| Command | Description |
|---------|-------------|
| `/create-kb` | Generate a new KB domain (gated) |
| `/update-kb` | Update/extend an existing KB domain |
| `/create-specialist` | Generate a specialist agent with its KB bound in the same pass |

## Review Commands (3)

| Command | Description |
|---------|-------------|
| `/review` | Dual-AI code review (CodeRabbit + Claude) |
| `/judge` | Cross-model second opinion via OpenRouter (V0) |
| `/codex-review` | Native cross-vendor review using the OpenAI Codex CLI |

## Visual Explainer Commands (8)

Generate self-contained HTML pages for visual documentation. Powered by the `visual-explainer` skill.

| Command | Description |
|---------|-------------|
| `/generate-web-diagram` | Generate standalone HTML diagram |
| `/generate-slides` | Magazine-quality slide deck as HTML |
| `/generate-visual-plan` | Visual implementation plan with state machines |
| `/diff-review` | Before/after architecture comparison |
| `/plan-review` | Current codebase vs. proposed plan |
| `/project-recap` | Project state, decisions, and cognitive debt |
| `/fact-check` | Verify document accuracy against codebase |
| `/share` | Share HTML page via Vercel |

See [visual-explainer/](visual-explainer/) for detailed usage.

## Usage

Commands are invoked in Claude Code:

```bash
# SDD workflow
claude> /define USER_AUTH

# Data engineering
claude> /pipeline "Daily orders ETL from Postgres to Snowflake"
claude> /schema "Star schema for e-commerce analytics"
claude> /sql-review models/staging/

# Visual explainer
claude> /generate-web-diagram "Data pipeline architecture"
claude> /generate-slides "Spindle overview for stakeholders"
claude> /diff-review main
```
