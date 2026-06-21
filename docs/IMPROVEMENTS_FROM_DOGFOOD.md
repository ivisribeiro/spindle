# Melhorias no Spindle — derivadas do dogfood (2026-06-21)

> Propostas concretas e priorizadas de melhoria no Spindle, derivadas de
> `DOGFOOD_LOG_erin-planning.md` (usar o Spindle pra planejar o erin-ingest real) +
> a lição de custo de token desta sessão. Cada item nomeia o arquivo/comando/gate a mudar.
> Status: **backlog** — nada implementado ainda. Decidir o que entra.

## Alta prioridade

### I1 — Artefato `audit` brownfield de primeira classe
**Problema:** o SDD do Spindle só modela greenfield define→design→build. Toda
auditoria brownfield força um schema ad-hoc sem CLI backing → nuance não é
gate-checkable. (Causa-raiz de 8+ itens de fricção.)
**Proposta:** add artefato `audit` em `schemas/sdd/schema.yaml` (id: audit, generates
AUDIT.md, model: opus, handoff: audit, parallel_group: by_domain) + `AuditHandoff` Zod
em `src/core/handoff/schemas.ts`. `proposedTasks` vira a ponte tipada audit→define
(`define requires: [audit]`). Gate `G_AUDIT` bloqueia se algum `built[]` sem evidência
ou gap sem severidade.

### I2 — Evidência estruturada + severidade de 3 valores nos handoffs
**Problema:** `built[]` flat força comprimir file+linha+prova numa prosa; `blocking`
boolean força under/overstate de risco.
**Proposta:** no `AuditHandoff`, `built` = `{item, evidence:{files[], lines?, proof}, status: 'proven'|'partial'|'scaffolded'}`; gaps com `priority: 'blocking'|'important'|'nice-to-have'`. Espelhar severidade nos AC do `DefineHandoff` pra sobreviver até o `G_BUILD`. Mudança Zod pura-aditiva + testes.

### I3 — Reconciliação doc-vs-código (`spin reconcile`)
**Problema:** a fricção mais repetida — docs vivos append-only driftam do código;
agentes releem 4 arquivos grandes toda vez pra distinguir aberto de silently-fixed.
**Proposta:** add `resolved_at_commit: string|null` + `verified_in_code: bool` em cada
item do `AuditHandoff`. Subcomando determinístico `spin reconcile --handoff audit.json`
que set-diffa doc-claimed-resolved vs handoff verified, exit 1 no mismatch, separando
stale-open de silently-fixed. **Doc drift vira exit code testável.**

### I4 — Balde ops-readiness + gate `G_OPS_CONFIG`
**Problema:** "código completo mas inerte pendente de config" (flag RLS derrotada por
superuser, runner-use-bundles default false, auth-mode mismatch) não cabe em weakPoint
nem gap. Invisível a static analysis + code review.
**Proposta:** `opsReadiness[]` no AuditHandoff = `{control, code_default, prod_value_required, env_files_checked[], enforced: bool}`. Gate `G_OPS_CONFIG` bloqueia quando `enforced=false` (flag com default inseguro cujo override de prod não foi verificado num env file). **"Feature pronta mas flag off em prod" vira exit-1.**

### I5 — Gate de qualidade do plano `G_PLAN`
**Problema:** o adversário pegou 4 defeitos de plano que nenhum gate pegaria (task
bundlada, mis-targetada, aceitação prosa, decisão de migração escondida) + 5 omissões.
**Proposta:** gate `G_PLAN` (opus-critical) antes do /build: (a) toda task tem aceitação
falsificável que nomeia comando/arquivo (bloqueia regex vago); (b) flag task L/XL que
bundla >1 subsistema → split obrigatório; (c) set-diff `gaps(blocking)`→tasks, exit 1 em
gap blocking órfão. **Mecaniza os passos `tooCoarse` + `omissions` do adversário.**

### I6 — Gate de CUSTO / budget-aware routing (a lição desta sessão)
**Problema:** nesta sessão gastamos ~8,8M tokens, muito em tarefas que não justificavam
fan-out + adversário (o content workflow: 33 arquivos × 3 agentes, vários triviais). A
própria doutrina de routing do Spindle ("tier mais barato que verificavelmente faz") não
estava sendo aplicada à DECISÃO DE ORQUESTRAÇÃO, só à escolha de modelo por agente.
**Proposta:** (a) add `taskTier: 'T0'|'T1'|'T2'` ao routing/policy — T0 main-loop (0 agentes),
T1 um agente sem adversário, T2 fan-out+adversário; (b) `spin route --estimate` que sugere
o tier por sinais (reversibilidade, amplitude, nº de arquivos); (c) adversário/fan-out só em
T2 ou em itens marcados críticos, nunca uniforme; (d) `budget` cap obrigatório em workflows
T2. Skill `model-routing` ganha a seção de tier. **Custo vira gate, não afterthought.**

## Média prioridade

### I7 — Dependências cross-domínio / external-precondition em `proposedTasks`
**Problema:** `dependsOn` só aponta task da mesma auditoria; sem expressar "depende de algo
fora do domínio" nem task cross-domain (IP2 spans backend+frontend+replan-LLM).
**Proposta:** `external_preconditions: string[]` + `domains: string[]` no item; quando
`domains.length>1`, o /design DEVE decompor. Opcional: `external_requires` no ArtifactGraph.

### I8 — Decomposição por domínio em auditorias grandes (parallel_group)
**Problema:** pass single sobre domínio grande perde os últimos arquivos (Brain ~5000 LOC).
**Proposta:** `parallel_group: by_domain` no artefato audit + comando `/audit` que lê
`.spindle/audit-domains.yaml` (`{domain, file_globs, max_files}`) e faz fan-out de 1 worker
bounded por domínio numa msg (reusa skill parallel-fanout); merge determinístico (task-kind
`merge` já existe). Cap de contexto por worker → mata o "últimos arquivos skimmed".

### I9 — Coverage + config-drift como output de primeira classe
**Problema:** make test (Postgres) vs CI (SQLite) silencioso; coverage não-quantificável;
ruff fora do lockfile; E2E infra-bound conflado com unit.
**Proposta:** (a) `coverage: {tool, pct, threshold}` no handoff de build/ship; (b) `test_tiers`
no audit (unit-sempre-passa vs infra-bound); (c) `spin config-drift` determinístico que flaga
"tool no CI mas não no lockfile" e "env var do CI != expectativa do conftest" (set-diffs puros).

### I10 — Checklist de omissão no adversário (regressão/idempotência/concorrência)
**Problema:** a contribuição mais forte do adversário foram 5 tasks omitidas que só apareceram
ao perguntar "o que quebra sob N runs / concorrência / redeploy?".
**Proposta:** encodar um omission-checklist fixo na skill `adversarial-gate` que o adversário
responde pra cada bug "resolvido" que a auditoria cita (tem teste de regressão? idempotente em
N runs? safe sob concorrência? sobrevive redeploy?). `invariants_at_risk: string[]` no
AuditHandoff (isolation/idempotency/concurrency) → "reconhecido num comentário mas sem teste"
vira item plannável.

---

## Priorização sugerida

1. **I6 (cost gate)** — resolve a dor imediata desta sessão; barato.
2. **I3 (doc-vs-code reconcile)** + **I4 (ops-readiness gate)** — a fricção mais repetida + a classe de bug mais perigosa (RLS inerte).
3. **I1 + I2 (audit artifact)** — destrava brownfield de primeira classe.
4. **I5 (G_PLAN)** + **I10 (omission checklist)** — qualidade do plano.
5. **I7/I8/I9** — refinamentos.

*Backlog. 2026-06-21. Fonte: DOGFOOD_LOG_erin-planning.md + a lição de custo.*
