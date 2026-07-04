# Data Engineering Commands

> **1 slash command** ships in core for legacy ETL migration; the other 7
> generic data-engineering commands are thin delegators that live in the
> optional, reversible `packs/commands/data-engineering/` bundle.

## Command Catalog (core)

| Command | Purpose | Workers |
|---------|---------|---------|
| `/migrate` | Legacy ETL migration with equivalence proof | migrate-dbt-worker / migrate-spark-worker / equivalence-worker |

## Command Catalog (`packs/commands/data-engineering/` — optional bundle)

| Command | Purpose | Primary Agent |
|---------|---------|---------------|
| `/pipeline` | DAG/pipeline scaffolding | pipeline-architect |
| `/schema` | Interactive schema design | schema-designer |
| `/data-quality` | Quality rules generation | data-quality-analyst |
| `/lakehouse` | Table format + catalog guidance | lakehouse-architect |
| `/sql-review` | SQL-specific code review | code-reviewer + sql-optimizer |
| `/ai-pipeline` | RAG/embedding scaffolding | ai-data-engineer |
| `/data-contract` | Contract authoring (ODCS) | data-contracts-engineer |

Not part of the core install — see [`packs/README.md`](../../../packs/README.md)
for how to bring one back with `git mv`.

## Quick Start

```bash
# Migrate stored procedures to dbt (core)
/migrate legacy/etl_orders_proc.sql

# The rest require packs/commands/data-engineering/ to be restored first:
# /schema "Star schema for e-commerce analytics"
# /data-quality models/staging/stg_orders.sql
# /pipeline "Daily orders ETL from Postgres to Snowflake"
# /sql-review models/marts/
# /data-contract "Contract between orders team and analytics"
```

## How Commands Work

`/migrate` fans out `migrate-dbt-worker` / `migrate-spark-worker` as competing
migration plans, has an independent `equivalence-worker` verify equivalence,
then gates on `G_REVIEW_BLOCK` before recommending. The optional pack commands
each delegate to a specialized agent that reads KB patterns, analyzes the
input, and generates production-ready code with confidence scoring.
