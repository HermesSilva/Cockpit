# CLAUDE.md — Diretivas do Projeto

> Arquivo de diretivas lido pelo Claude Code (e por qualquer agente) ao trabalhar neste repositório.
> Mantém escopo, princípios de arquitetura, convenções e o catálogo de features.

---

## 1. Identidade do produto

| Campo | Valor |
|-------|-------|
| **Nome de trabalho** | Tootega Cockpit for Claude Code *(nome provisório — a confirmar)* |
| **Autoria / Mantenedor** | **Tootega Pesquisa e Inovação** |
| **Tipo** | Extensão nativa do **Visual Studio Code** (GUI) |
| **Licença** | **MIT** (open source) |
| **Natureza** | Interface/ferramenta que opera **através do Claude Code CLI** — não reimplementa o agente |
| **Público** | Desenvolvedores que usam Claude Code e querem GUI rica, transparência de consumo e controle fino |
| **Idiomas** | **Bilíngue obrigatório**: pt-BR e **inglês internacional** (neutro, sem regionalismos US/UK) |

### Princípio fundador

Esta UI é **apenas uma camada de apresentação e controle**. Toda a orquestração — loop do agente, execução de tools, subagentes, todos, gestão de contexto, compactação, permissões, MCP, hooks, skills — **vive no Claude Code CLI**. A extensão:

1. **Renderiza** o stream de eventos que o CLI emite.
2. **Captura** input do usuário e implementa o lado-cliente dos protocolos interativos (aprovação de permissão, plan mode, respostas a perguntas).
3. **Nunca** reimplementa a lógica do motor. Se algo de orquestração precisa mudar, é problema do CLI, não nosso.

---

## 2. Arquitetura (resumo)

```
┌────────────────────────────┐         stream-json (stdout)        ┌─────────────────────────────┐
│   Claude Code CLI           │ ──────────────────────────────────▶ │  Extensão VSCode             │
│   (motor / engine)          │                                      │                              │
│   - agent loop              │ ◀────────────────────────────────── │  ┌────────────────────────┐  │
│   - tools, subagentes       │      input + respostas (stdin)       │  │ Webview (React)        │  │
│   - todos, contexto, cache  │                                      │  │ - chat / timeline      │  │
│   - permissões, MCP, hooks  │                                      │  │ - painel de stats      │  │
└────────────────────────────┘                                      │  │ - diff / checkpoints   │  │
                                                                     │  └────────────────────────┘  │
                                                                     │  ┌────────────────────────┐  │
                                                                     │  │ Host da extensão (TS)  │  │
                                                                     │  │ - spawn do processo    │  │
                                                                     │  │ - parser stream-json   │  │
                                                                     │  │ - APIs nativas VSCode  │  │
                                                                     │  └────────────────────────┘  │
                                                                     └─────────────────────────────┘
```

**Canal primário com o motor:** `claude` em modo headless/streaming:

```
claude -p --output-format stream-json --input-format stream-json --verbose
```

- `--output-format stream-json`: o CLI emite um evento JSON por linha (mensagens, tool_use, tool_result, usage, etc.).
- `--input-format stream-json`: permite enviar mensagens e respostas pelo stdin durante a sessão.
- Sessões retomáveis via `--resume <session_id>` / `--continue`.

**Fontes de dados complementares** (estatísticas/conta), descritas no plano de execução:
- Hook de **statusline** (JSON com `model`, `context_window`, `cost`, `rate_limits.five_hour`, `rate_limits.seven_day`).
- Comandos `/usage`, `/context`, `/cost` (ou seus equivalentes programáticos).
- Arquivos de sessão/transcript em `~/.claude/`.

> **Decisão de arquitetura registrada:** o canal é o **CLI**, não a Anthropic API/Agent SDK diretos. Isso mantém paridade automática com o motor oficial (auth, billing, limites da assinatura, features novas) sem reimplementar nada.

---

## 3. Stack técnico (alvo)

| Camada | Tecnologia |
|--------|-----------|
| Extensão (host) | TypeScript, VS Code Extension API |
| UI (webview) | React + Vite, CSS com tokens de tema do VSCode (`var(--vscode-*)`) |
| Comunicação webview ↔ host | `postMessage` / `acquireVsCodeApi()` |
| Comunicação host ↔ motor | `child_process` (spawn do `claude`), parser NDJSON |
| Diffs | API nativa de diff do VSCode + render custom no webview quando necessário |
| Testes | Vitest (unit), `@vscode/test-electron` (integração) |
| Empacotamento | `vsce` / `ovsx` (Open VSX para forks) |

---

## 4. Catálogo de features

Legenda de **Origem**: `Claude GUI` = extensão oficial do Claude Code · `CLI` = capacidade do motor a expor na UI · `Cline` / `Roo·Kilo` / `Windsurf·Cascade` = feature observada em outros agentes que vale incorporar · `Tootega` = diferencial nosso.
Legenda de **Prio**: `P0` MVP · `P1` essencial pós-MVP · `P2` diferencial.

### 4.1. Núcleo de conversa e agente

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| C1 | Chat com streaming token a token | Claude GUI | P0 |
| C2 | Render de blocos de pensamento (thinking) com toggle | CLI | P1 |
| C3 | Timeline de tool calls (cards por tool, input/output colapsáveis) | Claude GUI | P0 |
| C4 | @-mention de arquivos, pastas, símbolos | Claude GUI | P0 |
| C5 | Anexar imagens / colar screenshot no prompt | Claude GUI | P1 |
| C6 | Interromper o agente a qualquer momento (stop) | CLI | P0 |
| C7 | Fila de mensagens (enviar follow-ups sem esperar resposta) | Cline | P1 |
| C8 | Histórico de sessões: listar, retomar, buscar, renomear | CLI | P0 |
| C9 | Ordenar/filtrar sessões por data, **custo**, **tokens** | Cline | P2 |
| C10 | Subagentes: visualizar threads paralelas e seu progresso | CLI | P1 |

### 4.2. Edição, diff e controle humano

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| E1 | Inline diff lado a lado antes de gravar | Claude GUI | P0 |
| E2 | Aceitar/rejeitar mudança por arquivo e por hunk | Roo·Kilo | P1 |
| E3 | Aprovação de permissão (Allow/Deny + Allow-always) | CLI | P0 |
| E4 | Modo HITL vs. modo Agent-first (auto-approve configurável) | Roo·Kilo | P1 |
| E5 | Allowlist/denylist de tools e comandos por sessão/projeto | Roo·Kilo / CLI | P1 |
| E6 | Plan mode: ver, **editar** e aprovar o plano antes de executar | Claude GUI | P0 |
| E7 | Plan preview com passos numerados e aprovação por passo | Windsurf·Cascade | P2 |
| E8 | Painel de Todos do agente (lista viva, status por item) | CLI | P1 |

### 4.3. Checkpoints e recuperação

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| K1 | Checkpoint automático antes de mudanças grandes | Claude GUI / Cline | P0 |
| K2 | Rewind a partir de qualquer mensagem | Claude GUI | P1 |
| K3 | Modos de restore: **Restore Files** · **Restore Files Only** · **Restore Files & Task** | Cline | P1 |
| K4 | Visualização de snapshot (o que mudou no checkpoint) | Cline | P2 |

### 4.4. Estatísticas, contexto, cache e consumo *(coração do produto)*

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| S1 | Medidor de **janela de contexto**: usado / restante / limite (200K · 1M) | CLI | P0 |
| S2 | **Breakdown de contexto**: system prompt, tools, MCP, mensagens, arquivos, todos, thinking | CLI (`/context`) | P1 |
| S3 | **Cache**: tokens de escrita, leitura, hit-rate e economia estimada | CLI / API usage | P1 |
| S4 | **Custo**: por request, por sessão e acumulado (tokens + $) | Cline / CLI (`/cost`) | P0 |
| S5 | Tokens por categoria: input, output, cache-create, cache-read | CLI | P1 |
| S6 | **Limites da assinatura**: janela 5h e 7d, % usado e horário de reset | CLI (`rate_limits`) | P0 |
| S7 | Indicador de **pacing** (ritmo de consumo vs. limite) | Statusline / Tootega | P2 |
| S8 | Modelo ativo, effort, modo (plan/normal), workspace | CLI (statusline) | P0 |
| S9 | Alertas: contexto perto do limite, compactação iminente, limite de plano | Tootega | P1 |
| S10 | Histórico/gráficos de consumo ao longo do tempo (sessão e diário) | Cline / Tootega | P2 |
| S11 | Evento de **compactação** visível (quanto foi condensado) | CLI | P2 |

### 4.5. Extensibilidade (expor o que o CLI permite)

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| X1 | Slash commands (built-in + custom do projeto/usuário) com autocomplete | CLI | P0 |
| X2 | Skills: listar, descrever, acionar | CLI | P1 |
| X3 | Subagentes customizados: listar e selecionar | CLI | P1 |
| X4 | MCP servers: status, tools expostas, conectar/desconectar | CLI | P1 |
| X5 | Hooks: visualizar configurados e seus disparos | CLI | P2 |
| X6 | Editor de `CLAUDE.md` / settings com validação | CLI | P1 |
| X7 | Gestão de permissões persistidas (settings.json) | CLI | P1 |

### 4.6. Modos e produtividade

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| M1 | Modos por papel (Code, Architect, Ask, Debug, Test) como presets | Roo·Kilo | P2 |
| M2 | Seletor de modelo e de effort por sessão | CLI | P1 |
| M3 | Consciência de workspace: arquivos abertos, seleção, terminal | Windsurf·Cascade | P2 |
| M4 | Memória de projeto (notas persistentes que o agente consulta) | Windsurf·Cascade | P2 |
| M5 | Múltiplas sessões/abas simultâneas | Tootega | P2 |
| M6 | Integração com git worktrees (sessão por branch) | Tootega | P2 |

### 4.7. Apresentação e acessibilidade

| # | Feature | Origem | Prio |
|---|---------|--------|------|
| P1 | Tema sincronizado com o VSCode (claro/escuro/high-contrast) | Claude GUI | P0 |
| P2 | Markdown rico + syntax highlight nos blocos de código | Claude GUI | P0 |
| P3 | Atalhos de teclado e navegação por teclado completa | Claude GUI | P1 |
| P4 | **i18n bilíngue: pt-BR + inglês internacional**, troca em runtime, segue locale do VSCode | Tootega | **P0** |
| P5 | Densidade de UI configurável (compacto/confortável) | Tootega | P2 |

---

## 5. Convenções de código

- **Idioma:** identificadores e código em inglês; comentários e docs do repositório em **pt-BR**.
- **Estilo:** seguir o padrão do arquivo vizinho (naming, densidade de comentário, idioma).
- **Sem reimplementar o motor.** Se a tentação for replicar lógica de orquestração, pare — exponha o que o CLI já faz.
- **Parsing do stream:** tolerante a versões — eventos desconhecidos são ignorados graciosamente, nunca quebram a UI.
- **Segurança:** nunca logar conteúdo de credenciais; respeitar o modelo de permissão do CLI; não burlar prompts de aprovação.

### i18n (regra obrigatória)

- **Toda string visível ao usuário passa por i18n.** Proibido texto hardcoded na UI — usar chaves de tradução.
- **Locales suportados:** `pt-BR` e `en` (inglês **internacional**, neutro — vocabulário e datas/números sem viés US/UK).
- **Idioma padrão:** segue o `vscode.env.language`; cai para `en` quando o locale não for suportado. Override manual nas settings.
- **Troca em runtime** (sem reload da extensão).
- Catálogos em `l10n/` (`bundle.l10n.pt-br.json`, `bundle.l10n.json` como base em inglês), via `vscode.l10n` no host e equivalente no webview.
- Pluralização e interpolação tratadas pela camada de i18n, nunca por concatenação de strings.

---

## 6. Não-objetivos (escopo fora)

- Não substituir nem competir com a extensão oficial em paridade 1:1 — buscamos **transparência de consumo e controle fino** como diferencial.
- Não falar com a Anthropic API diretamente (o canal é o CLI).
- Não implementar billing/pagamento próprios — a conta e os limites são os da assinatura Claude do usuário.
- Não armazenar dados do usuário fora da máquina dele.

---

## 7. Documentos relacionados

- [Docs/plano-de-execucao.md](Docs/plano-de-execucao.md) — roteiro, marcos e requisitos detalhados.
