# Dogfood log — Spindle aplicado ao planejamento do erin-ingest (2026-06-21)

> Log de fricção e erros capturado ao usar a metodologia do Spindle (SDD
> brainstorm→design, gates, model routing, adversário) pra planejar um projeto
> real, grande e bagunçado (erin-ingest). Cada item é um ponto onde o processo
> spec-driven/harness foi awkward, ambíguo ou sem suporte. Alimenta
> `IMPROVEMENTS_FROM_DOGFOOD.md`.

## Run

- Workflow: `erin-ingest-plan-dogfood` (wf_b87a103a-4dd). 10 agentes, 1,2M tokens, ~51 min.
- Fases: Brainstorm (6 auditores domínio + 1 Notion) → Design (síntese Opus) → Evaluate (adversário Opus) → SpindleFeedback (Opus).
- **Erros de runtime: nenhum.** 6/6 auditores + Notion + design + adversário + feedback retornaram. 0 agentes nulos, 0 falha de schema.
- Veredito do adversário sobre o plano: `needs-fixes` (0.83) — 3 mis-orderings, 5 omissões, 4 já-feitos, 4 too-coarse, 10 fixes. Todos aplicados.

## Fricção por tema (39 itens, agrupados)

### A. Falta um artefato de AUDITORIA brownfield (8+ itens → causa-raiz)
- O SDD do Spindle só modela greenfield define→design→build. Cada agente teve que inventar um schema de auditoria ad-hoc (`built/weakPoints/gapsToFinish/proposedTasks`) sem backing de CLI → nenhuma nuance da auditoria é gate-checkable.
- `built[]` é lista flat de strings → comprimiu "file path + linhas + prova comportamental" em uma prosa por item.
- `gapsToFinish[].blocking` é boolean → forçou understatement (marcar non-blocking) ou overstatement (blocking) de itens "importante mas não bloqueia 1º cliente" (drift detection, caching, SQL dry-run).
- Não dá pra expressar dependência cross-domain em `proposedTasks` (ex: "seed Silver enrichment depende de Silver materializado no Polaris" — concern de outro domínio).

### B. Doc-vs-código: drift e re-leitura cara (most-repeated, ~7 itens)
- Docs vivos (MUDANCAS_PARA_PRODUCAO.md) são append-only → itens marcados "fixed"/"[ ]" driftam da realidade (fix LGPD, PlanningLoop dead-code, flag RLS — listados abertos, na real resolvidos).
- Agentes tiveram que reler 4 arquivos grandes (CLAUDE.md, MUDANCAS, PRODUCTION_READINESS, código) linha-a-linha pra distinguir aberto de silently-fixed. "Nenhum sinal automático de doc-freshness."
- IP numbering (IP1-IP9) + seções F/D/Go-live misturam ideia de produto, bug de infra e config operacional num flat list → difícil triar blocking-pro-1º-cliente vs nice-to-have.
- O doc não é machine-readable. Formato estruturado (status enums + verified-at-SHA) deixaria o harness perguntar "o que bloqueia?" programaticamente.

### C. "Código completo mas operacionalmente inerte" não tem balde (saas-security + data-plane)
- Classe de issue invisível a static analysis E a code review: flag RLS derrotada por role superuser; `ERIN_RUNNER_USE_BUNDLES` default false em prod; `NEXT_PUBLIC_ERIN_AUTH_MODE` vs `ERIN_DEV_AUTH_ENABLED` mismatch; `typescript.ignoreBuildErrors`.
- Não é weakPoint (código tá ok) nem gap (capability existe) — é deployment gap. Precisa de bucket próprio + gate.

### D. Auditoria de domínio grande perde fidelidade no fim (brain, control-plane)
- Brain: 10+ arquivos, ~5000 LOC num único pass → contracts.py/contributions.py com menos escrutínio que os primeiros lidos. Pediu split "Brain core vs Brain integration" em 2 agentes paralelos.
- Orquestração: 8+ arquivos interagindo sem teste de integração single que ancore o trace de uma materialização completa.

### E. O plano precisa de gate de qualidade (4 defeitos que nenhum gate pegaria)
- P1-T1 agrupou fix crítico de 1 linha atrás de cleanup de 2374 erros (caro bloqueando barato).
- P1-T7 mis-targetado num path já-wirado.
- P1-T9 aceitação prosa não-falsificável quando já existe script de 32 checkpoints.
- 5 tasks inteiras omitidas (graceful shutdown, regressão idempotência, concorrência, cache-bust, signup bypass-scope) — exatamente o que um plano forward-only perde.

### F. Test-coverage e config-drift invisíveis (quality-ops)
- `make test` usa Postgres mas CI pytest cai pra SQLite (`DATABASE_URL` != `ERIN_TEST_DATABASE_URL`) → testes RLS pulados verde.
- `services/` (10,8k LOC) sem coverage quantificável (sem `--cov`).
- Ruff chamado no CI mas ausente do uv.lock — levou várias tool calls pra confirmar.
- E2E infra-bound (Magalu VM) conflado com unit tests sempre-verdes → "suíte verde" é ambíguo.

### G. Backstop de omissão do adversário (a contribuição mais forte)
- 5 tasks omitidas só apareceram porque o adversário perguntou "o que quebra sob N runs / concorrência / redeploy?". Sem checklist fixo de invariantes (isolamento/idempotência/concorrência), um plano forward-only não pega.

### H. Notion stale (5 itens)
- Páginas datadas 2026-05-27/30 predatam ADR-0028/0029 → afirmam Dagster/DataHub vivos (superseded). CLAUDE.md é a autoridade canônica, não a Notion.
- Roadmap não reflete Silver como shipped (marca como "Fase 3 futura") → risco de under-sell comercial.
- Pricing/tiers da Notion não wirados aos tiers do código + Stripe TODO → sem enforcement/cobrança real.

---

## Erros reais de runtime (modo "ultravioleta" — logar tudo)

- **Nenhum erro de execução neste run.** Todos os 10 agentes completaram, schemas validaram, sem nulls.
- (Sessões anteriores do Spindle, pra referência: o refiner do design-lock STUBOU o structured output — recuperei do synthesizer; o content workflow teve 26 fixes/8 críticos pegos pelo adversário; o KB schema tinha colon não-quotado no YAML — pego pelo dogfood do próprio gate.)

---

*Capturado 2026-06-21. Vira input direto de `IMPROVEMENTS_FROM_DOGFOOD.md`.*
