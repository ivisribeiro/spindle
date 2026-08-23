# Spindle — oportunidades de melhoria de produto

Data: 2026-06-27  
Escopo: leitura do código, schemas, comandos do plugin, testes e probes locais. Não usei os documentos existentes de oportunidades como fonte para evitar análise circular.

## Validação executada

- `npm test` — passou: 32 arquivos, 303 testes.
- `npm run test:coverage` — passou: 92.7% statements, 82.43% branches, 94.06% lines.
- `npm run eval` — passou: 22/22 fixtures, com cobertura pass/block dos 11 gates registrados.
- Probes locais em diretórios temporários para conferir comportamento de `spin complete`, `spin next` e `G_ROUTER_COVERAGE`.

## Leitura rápida do produto

Spindle tem um núcleo técnico forte: o CLI `spin` é uma espinha determinística que ordena artefatos, valida handoffs, registra ledger, roda gates e roteia tiers sem chamar modelos. O lado de modelo fica em comandos markdown e workers. Essa separação é o diferencial real do produto.

A maior oportunidade não está no core conceitual; está em transformar essa tese em produto difícil de usar errado: menos lacunas entre schema/comando/CLI, menos documentação manual que drift, melhor validação do runtime real do plugin e melhor distribuição.

## Oportunidades priorizadas

### P0 — Tornar os hooks de gate do schema realmente enforceáveis em todos os workflows

Hoje o core só enxerga hooks no formato `before_<artifactId>`. Isso funciona para o SDD (`before_design`, `before_build`, `before_ship`), mas não para hooks genéricos presentes nos schemas KB e brownfield, como `during` e `before_complete`.

Evidência:

- `ArtifactGraph.getRequiredGatesBefore()` lê apenas `schema.gates["before_${artifactId}"]`.
- `schemas/brownfield/schema.yaml` declara `gates: during: G_AUDIT`.
- `schemas/kb/schema.yaml` declara `during: G_KB_STRUCTURE` e `before_complete: G_KB_COVERAGE`.
- Probe: um audit handoff vazio passa por `spin complete audit --handoff ...` e desbloqueia `define` em `spin next`; só depois `spin gate G_AUDIT` bloqueia.

Impacto de produto: o usuário acredita que brownfield/KB são gate-backed pelo schema, mas parte da segurança depende de o comando markdown lembrar de chamar o gate certo. Isso reabre, nesses fluxos, uma versão do problema que Spindle tenta eliminar.

Sugestão:

- Formalizar o contrato de hooks (`before_<id>`, `after_<id>`, `before_complete`, `during` etc.) ou reduzir o schema aos hooks que o CLI realmente entende.
- Fazer `spin complete` e `spin next` considerarem os hooks declarados para todos os workflows.
- Adicionar probes/e2e para brownfield e KB mostrando que `complete`/`next` não avançam quando gate declarado no schema está vermelho.

### P0 — Alinhar `spin complete` com o contrato real dos artefatos sem handoff

`spin complete` só valida handoff quando o artifact declara `handoff:`. Se o artifact não declara handoff, ele pode ser marcado completo mesmo sem o arquivo gerado existir; e um `--handoff` passado por engano é ignorado para validação.

Evidência:

- `schemas/sdd/schema.yaml` define `brainstorm` sem `handoff:`.
- `completeHandler()` só chama `checkHandoffFile()` dentro de `if (artifact.handoff)`.
- Probe: em um projeto SDD recém-inicializado, `spin complete brainstorm` retorna exit 0 sem `BRAINSTORM.md` existir.
- `/brainstorm` documenta que `complete brainstorm --handoff ...` pode sair 1 se o JSON for inválido, mas isso não acontece porque o artifact não tem `handoff:`.

Impacto de produto: alguns comandos dão ao operador uma garantia que o core não está dando. Isso reduz a confiança na promessa “done é sempre uma decisão do spin”.

Sugestão:

- Para artifacts sem handoff, `spin complete <id>` deveria pelo menos verificar `artifact.generates` quando não for glob opcional.
- Se `--handoff` for passado para um artifact sem `handoff:`, retornar usage error ou suportar explicitamente um `handoff` no schema.
- Considerar um `brainstorm` handoff próprio ou remover a sidecar do comando.

### P0 — Fazer spec-drift bloquear o ship no mesmo gate, não só depois do gate verde

`G_SHIP` atualmente passa quando todos os critérios foram marcados como `passed` e há aprovação humana, mesmo que o build tenha `corrected_spec: true` não reconciliado. O alerta aparece em `reasons`, e o comando `/ship` roda `spin spec-drift` depois.

Evidência:

- `gShip()` monta `reasons` com aviso de `CORRECTED`, mas retorna `pass()` mesmo quando `specDrift(...).clean` é falso.
- Teste atual afirma explicitamente: “passes but SURFACES spec-drift”.
- `/ship` diz que “G_SHIP passes even when the build flagged a corrected_spec drift” e só depois roda `spec-drift`.

Impacto de produto: o ledger pode registrar `G_SHIP` verde antes da reconciliação. Mesmo que o comando correto pare depois, o estado intermediário contradiz a mensagem de produto “um spec falso não pega carona num build verde”.

Sugestão:

- Tornar `specDrift.clean === false` um block de `G_SHIP` com `unmet: spec-drift:<AC>`.
- Alternativa menos quebrante: criar `G_SPEC_DRIFT` e declará-lo no schema antes de `ship`, mas o ideal é manter o veredito final em um único gate verde só quando o estado está realmente shipável.

### P1 — Substituir merges manuais de findings por `spin merge-findings` nos comandos

O CLI já tem `merge-findings` determinístico, mas `/review` ainda instrui o comando/modelo a ler dois arquivos e mesclar manualmente por `(file,line)`, mantendo o de maior severidade. Isso é uma decisão de preservação/dedup de achados antes do gate e pode derrubar ou alterar findings críticos.

Evidência:

- `/review` Step 5 descreve merge manual dos findings.
- O CLI possui `merge-findings`, que deduplica por `file+line+rule`, mantém severidade maior e agrega `sources`.
- `/codex-review` já usa `merge-findings` quando junta Codex com reviewers internos.

Impacto de produto: uma das áreas mais críticas — review/adversarial findings — ainda tem uma etapa model-side onde o produto já tem primitiva determinística disponível.

Sugestão:

- Atualizar `/review` para usar `spin merge-findings .spindle/review/.handoffs/arch.json .spindle/review/.handoffs/security.json --out findings.json`.
- Depois rodar `G_REVIEW_BLOCK --findings findings.json --min-sources 2` quando aplicável.
- Adicionar lint de comandos para impedir merge manual onde existe subcomando determinístico equivalente.

### P1 — Fortalecer `G_ROUTER_COVERAGE`: hoje ele prova presença, não roteamento semântico

O router é um arquivo plano `{ agents: [...] }`. O gate prova bijection de nomes e integridade de `kb_domains`, mas não prova que cada comando referencia um agente existente, que o agente certo está associado ao task-kind certo, nem que frontmatter incompleto sempre falha.

Evidência:

- `plugin/skills/agent-router/routing.json` é apenas uma lista de nomes.
- `G_ROUTER_COVERAGE` valida presença/duplicidade/extra e `kb_domains`, mas não modela capacidades por comando/task-kind.
- `parseAgentFrontmatter()` tem fallback tolerante: se a validação estrita falha, um agent com apenas `name:` pode ser aceito com `description` igual ao nome.
- Probe: um agent markdown com só `name: alpha` passou em `G_ROUTER_COVERAGE` quando estava listado em routing.

Impacto de produto: o gate evita orphan files, mas ainda não garante que a malha de comandos → task kind → worker → KB está correta. Para um produto de orquestração, essa é a próxima camada de confiança.

Sugestão:

- Transformar routing em tabela rica: `{ agent, task_kinds, model, kb_domains, commands }`.
- Fazer `G_ROUTER_COVERAGE` checar descrição obrigatória, tools/model válidos, task kinds conhecidos e referências de comandos a agents existentes.
- Se o fallback de frontmatter continuar existindo, retornar `degraded: true` como warning/block configurável.

### P1 — Criar testes de contrato para os comandos markdown, não apenas referências a IDs reais

Há um teste útil que varre comandos e garante que `spin gate`, `spin route` e `handoff-check` citam IDs existentes. Mas ele não pega contradições de protocolo, paths inexistentes, comando que promete validação não executada, ou drift de inventário.

Evidência:

- `test/e2e/command-references.test.ts` valida só gates, task-kinds e handoff IDs citados.
- Exemplos de drift encontrados:
  - `/brainstorm` promete invalidar handoff, mas o artifact não tem handoff.
  - `/review` não usa `merge-findings` determinístico.
  - `plugin/commands/README.md` diz “28 slash commands”, mas o checkout tem 30 comandos markdown.
  - `plugin/commands/README.md` ainda mostra uso de comandos movidos para `packs/`.
  - `/judge` referencia `docs/getting-started/judge-setup.md` e `tasks/backlog.md`, que não existem no checkout.

Impacto de produto: o produto é fortemente document-driven. Se comandos são o runtime model-side, eles precisam de testes mais fortes que “os nomes existem”.

Sugestão:

- Adicionar um linter de comandos que verifica:
  - todo worker citado existe em `plugin/agents`;
  - todo arquivo local citado existe ou é explicitamente gerado;
  - `complete <id> --handoff` só aparece quando `<id>` declara handoff;
  - comando que faz merge usa `spin merge-findings` quando disponível;
  - README de comandos é gerado a partir da árvore real.
- Criar modo `spin command-audit` ou teste Vitest específico.

### P1 — Resolver inventário/distribuição: core vs packs vs marketplace ainda driftam

O produto já separou core e packs, mas a superfície de instalação/descrição não está totalmente sincronizada.

Evidência:

- `plugin/.claude-plugin/plugin.json` descreve 17 core agents e 11 gates.
- `.claude-plugin/marketplace.json` ainda anuncia 65 agents, 24 KB domains, 33 commands e 9 gates.
- `packs/README.md` diz que os packs são opcionais e sugere que um futuro `spin pack add` poderia automatizar o retorno ao core.
- O plugin tem 17 agents, 30 commands e 1 KB domain no checkout atual.

Impacto de produto: um usuário instalando ou avaliando o marketplace recebe uma promessa diferente do que o core carrega. Isso afeta confiança e adoção.

Sugestão:

- Gerar marketplace metadata e command/agent counts automaticamente no build.
- Implementar `spin pack list/add/remove` ou remover a promessa do README até existir.
- Separar “core harness” e “domain pack” como SKUs/instalações claras.

### P2 — Melhorar suporte a múltiplas features/runs ativos

O run-state é um único `.spindle/run.json` com um único `feature`. `spin init` cria/reescreve essa run ativa. Ao mesmo tempo, comandos e status falam em múltiplas features sob `.spindle/features/*`.

Evidência:

- `RunStateSchema` tem `feature: z.string()` único.
- `initRunState()` cria um único estado ativo com `completed`, `gates`, `retries` e `approval` globais para a run.
- `/status` escaneia múltiplos arquivos/features em `.spindle/features/*`, mas o CLI core opera a feature ativa.

Impacto de produto: isso é aceitável para MVP, mas limita uso real em repositórios com várias iniciativas concorrentes. Também cria risco de o usuário achar que `--feature` em comandos seleciona uma feature quando o CLI na prática segue a run ativa.

Sugestão:

- Suportar `.spindle/runs/<feature>/run.json` ou `spin --feature <slug>` como seletor real.
- Ou deixar explícito no produto: “Spindle suporta uma run ativa por checkout; use worktrees para paralelismo”.

### P2 — Configurar model routing como policy externa/versionada

A tabela de modelos e task-kinds é forte, mas hard-coded em TypeScript. Isso dificulta atualizar nomes de modelos, trocar provider, ou adaptar Spindle para Codex/OpenAI sem rebuild.

Evidência:

- `MODEL_IDS` fixa `claude-haiku-*`, `claude-sonnet-*`, `claude-opus-*` em `src/core/model-route/policy.ts`.
- O plugin/README ainda é majoritariamente Claude Code-first, enquanto há comandos de Codex review e uso cross-vendor.

Impacto de produto: roteamento é parte central da UX e vai envelhecer mais rápido que os gates. Manter isso no core compilado aumenta fricção operacional.

Sugestão:

- Mover `MODEL_IDS` para `plugin/skills/agent-router/routing.json` ou `spindle.config.yaml`, mantendo o CLI determinístico.
- Validar a policy com schema e testes, mas permitir override por workspace.

### P2 — Tornar handoff schemas mais estritos onde typo é risco

Os schemas Zod de handoff são em grande parte objetos não-`strict`, com vários defaults. Isso é bom para compatibilidade, mas pode aceitar typo em campos opcionais importantes sem avisar.

Evidência:

- `BuildReportHandoff` usa defaults para `results` e `files_written`.
- `AuditHandoff` usa defaults para muitos arrays.
- `kb-concept` aceita campos extras, usado inclusive por `/update-kb` para `stale_since`.

Impacto de produto: em fases críticas, um typo como `files_writen` ou campos extras inesperados pode passar pela validação estrutural e só aparecer, se aparecer, em gate posterior.

Sugestão:

- Separar schemas “strict core” de “extensions allowed”.
- Adicionar warnings em `handoff-check` para unknown keys, sem quebrar compatibilidade inicialmente.
- Para build/ship/review, considerar `.strict()` com whitelist de extensões.

## Síntese executiva

Minha priorização:

1. **Fechar bypasses de gate por schema hook** — especialmente brownfield/KB.
2. **Corrigir `spin complete` para artifacts sem handoff** — não marcar “done” sem output real.
3. **Fazer spec-drift bloquear `G_SHIP`** — ledger verde só quando shipável de verdade.
4. **Mover merges de findings para `spin merge-findings`** — evitar decisão model-side antes do gate.
5. **Expandir command/router lint** — porque os comandos markdown são metade do runtime do produto.
6. **Sincronizar distribuição/metadata e suportar packs** — tirar atrito de adoção.

Estado geral: Spindle está tecnicamente forte no core determinístico; as melhores melhorias agora são de “product hardening”: tornar impossível operar errado mesmo fora do caminho feliz e fazer docs/comandos/distribuição serem gerados ou verificados como parte do produto.
