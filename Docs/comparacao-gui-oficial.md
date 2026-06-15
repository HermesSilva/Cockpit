# Comparação item-a-item: GUI oficial do Claude Code × Tootega Cockpit

> Gerado por pesquisa multi-agente (doc oficial + superfície CLI + guias + integração IDE) cruzada com inventário do nosso repo.
> Legenda: ✓ tem · ◑ parcial · ✗ não tem. Importância: **core** / sec (secundária) / min (mínima).

## ✅ Atualização — 15 itens simples implementados (2026-06-13)
Fechadas as 15 lacunas mais simples da lista:
1. **Seletor de modo de permissão** na UI (combo + override de sessão + reflete no settings) — fecha "permission mode selector".
2. **Autocomplete de slash commands** no composer (vem do `slash_commands` do init; ↑↓/Enter/Esc) — fecha parte de "slash menu".
3. **Busca de sessões** (filtro por título) — fecha "session search".
4. **Renomear sessão** (✎ inline, persistido em globalState) — fecha "session rename".
5. **Expandir thinking por padrão** (setting `tootega.showThinking`) — fecha o "◑ thinking".
6. **Notificação ao concluir** quando o painel está oculto (`tootega.notifyOnComplete`) — fecha "completion notifications".
7. **Status bar item** (busy spinner / idle, clica e abre) — fecha "background progress in status bar".
8. **Keybindings** (abrir, nova sessão, interromper) — fecha "rebindable keybindings/reopen".
9. **Botões no título da view** (Sessões / Nova / Interromper) — fecha "multiple entry points".
10. **Painel de Todos** (do TodoWrite, com progresso e status) — fecha "dedicated todos display".
11. **URI handler** `vscode://tootega.tootega-cockpit/open` — fecha "URI handler".
12. **Workspace trust** declarado (`capabilities.untrustedWorkspaces`) — fecha "Restricted Mode".
13. **Copiar bloco de código** (botão ⧉ no CodeBlock).
14. **Copiar mensagem** (botão no hover das bolhas).
15. **Scroll-to-bottom** (botão flutuante quando rolado pra cima).

> Itens da tabela abaixo afetados passam a **✓** ou **◑→✓**: permission selector, slash (◑), session search/rename, thinking, notifications, status bar, keybindings, entry points, todos, URI, trust, copy.
> **Ainda faltam (core):** diff inline, plan mode revisável, @-mentions, checkpoints/rewind, multi-aba, MCP/plugins/hooks/skills/output-styles/statusline/memory, sign-in/onboarding. E os 2 quick wins de dados: limites 5h/7d e breakdown de contexto.

## Resumo
Cockpit é um cliente webview limpo que dirige o Claude Code CLI. Faz bem o **núcleo da conversa** (streaming, thinking, tool cards com render por ferramenta, markdown, highlight), **modelo/effort com descoberta ao vivo**, **painel de stats** (contexto/custo/cache/tokens), **histórico/retomar/apagar sessão**, **paste de imagem+arquivo**, **modal de permissão**, **i18n pt-BR/en**, **tema sincronizado**.

**Maior lacuna:** revisão de **diff inline lado-a-lado** (hoje só aprovamos edição via modal de permissão com JSON cru). Também faltam: menu de slash, @-mentions/seleção, plan-mode revisável, checkpoints/rewind, MCP, plugins, subagentes, hooks, skills, output-styles, statusline, onboarding, browser, Jupyter, remote control, multi-aba, sign-in.

**Dois itens construídos-mas-não-ligados:** barras de limite 5h/7d mostram "Não reportado"; breakdown de contexto está stub.

---

## Tabela item-a-item

| Feature | Oficial | Nós | Imp. | Nota |
|---|:--:|:--:|:--:|---|
| Painel de chat gráfico | ✓ | ✓ | core | dirige o CLI instalado |
| Streaming de tokens | ✓ | ✓ | core | partial-messages + fallback |
| Exibição de thinking | ✓ | ◑ | core | só toggle, sem expandir global |
| Tool cards + render | ✓ | ✓ | core | ícones bash/read/write são extra nosso |
| Markdown + highlight + gutter + links | ✓ | ✓ | core | highlight.js + gutter extra |
| **Diff inline lado-a-lado** | ✓ | ✓ | core | LCS próprio; no modal de permissão (Edit/Write/MultiEdit) e nos tool cards. Falta editar o diff antes |
| Aprovação de permissão (Allow/Always/Deny) | ✓ | ✓ | core | via `--permission-prompt-tool stdio` + `can_use_tool`; preview por ferramenta |
| Perguntas interativas (AskUserQuestion) | ✓ | ✓ | core | janela com abas, multiSelect e "Outro" |
| Seletor de modo de permissão + auto-accept | ✓ | ◑ | core | só via setting, sem Shift+Tab |
| Plan mode revisável | ✓ | ◑ | core | `ExitPlanMode` renderizado e aprovável; sem editar antes |
| Menu de slash commands / skills | ✓ | ✗ | core | enviamos `/cmd` verbatim |
| Seletor de modelo + descoberta ao vivo | ✓ | ✓ | core | `/v1/models` + init = extra |
| Seletor de effort | ✓ | ✓ | sec | combo |
| Medidor contexto/custo/cache/tokens | ✓ | ✓ | core | estimativa local + painel cache = extra |
| Janelas de limite + breakdown de uso | ✓ | ◑ | sec | **barras e breakdown prontos mas não ligados** |
| Stop + nova sessão | ✓ | ✓ | core | encerra e reinicia o CLI |
| Histórico: retomar/apagar | ✓ | ✓ | core | lê `.jsonl`, diálogo de confirmação |
| Sessões: buscar/renomear/auto-resume/remoto | ✓ | ◑ | sec | auto-resume é extra; sem rename/remoto |
| Checkpoints / rewind | ✓ | ✗ | core | ausente |
| Conversas paralelas (abas + dots) | ✓ | ✓ | core | runtimes por aba (CLI/stats/streaming) em paralelo; dot idle/busy/error por aba |
| @-mention seleção/arquivo ativo | ✓ | ✗ | core | sem autocomplete |
| Refs de PDF (páginas) e terminal | ✓ | ✗ | min | ausente |
| Paste imagem/arquivo/path + drag | ✓ | ✓ | sec | paste de path é extra; sem drag-attach |
| Scroll markers + tooltips + status bar | ◑ | ✓ | sec | trilho e tooltips são extras nossos |
| Todos / subagentes / agents / bg tasks | ✓ | ◑ | core | cards genéricos, sem gestão |
| Tema sincronizado | ✓ | ✓ | core | tokens do VSCode |
| **i18n bilíngue runtime** | ✗ | ✓ | core | **extra grande nosso** (sem reload) |
| Detecção do CLI + parser tolerante | ◑ | ✓ | sec | dot vermelho + tolerância a versão = extra |
| Conjunto de comandos / entry points | ✓ | ◑ | core | 4 comandos, só activity bar |
| Sign-in / onboarding | ✓ | ✗ | core | dependemos do auth do CLI; só hint estático |
| MCP / IDE server / diagnostics / plugins | ✓ | ✗ | core | sem UI de MCP/plugin |
| Jupyter + browser automation | ✓ | ✗ | sec | ausente |
| Statusline/output-styles/memory/hooks/compaction | ✓ | ✗ | core | superfície inteira ausente |
| Review/worktrees/workflows/remote control | ✓ | ✗ | sec | ausente |
| Keybindings/reposição/terminal mode/URI | ✓ | ✗ | core | só webview fixo, sem atalho de foco |
| Settings (autosave/gitignore/python/providers/trust/schema) | ✓ | ◑ | min | só algumas; sem env/providers |
| Notificações + bell | ✓ | ✗ | min | só o dot no painel |
| Instalação (forks/Open VSX/JetBrains) | ✓ | ◑ | core | só 1 ext VS Code, versão 0 |
| Limite de contexto auto pelo modelo (1M/200K) | ✓ | ✓ | — | derivado do modelo ativo |
| Diálogo de uso + atribuição | ✓ | ✗ | sec | ausente |

---

## Lacunas (só a oficial tem) — desdobradas

**Core / alto impacto**
- Diff inline lado-a-lado + editar o diff antes de aceitar
- Plan mode: plano markdown editável com comentários inline
- Seletor de modo de permissão na UI com ciclo Shift+Tab
- Menu de slash + comandos built-in e custom
- Skills (bundled + custom, SKILL.md)
- @-mention de arquivos/pastas com fuzzy; @-seleção (linhas, Alt/Option+K)
- Compartilhamento automático de seleção/arquivo ativo (toggle olho)
- Checkpoints + rewind (fork-rewind, duplo Esc)
- Múltiplas conversas em abas/janelas + dots de status por aba
- Sign-in (login/logout) + onboarding (checklist, Open Walkthrough)
- MCP: gestão de servidores, OAuth/scopes, resources, tool search
- IDE MCP server embutido: getDiagnostics, executeCode, compartilhar diagnósticos
- Plugins: GUI + marketplaces
- Subagentes built-in/custom + UI de agents + painel de background tasks
- Hooks (25+ eventos de ciclo de vida)
- Output styles (built-in + custom)
- Memory: CLAUDE.md, regras de path, auto-memory, memory init
- Compaction (compact + auto)
- Statusline customizável (scriptável)
- Diálogo de uso com atribuição por skill/subagente/plugin/MCP
- Breakdown de contexto colorido em grade + dicas de otimização
- **Barras de limite 5h/7d realmente alimentadas com dados**
- Keybinding de foco (Cmd/Ctrl+Esc), rebindável; atalhos de reabrir/novo
- Terminal mode (useTerminal) + ponte de terminal externo IDE
- Múltiplos entry points (toolbar do editor, spark, activity bar, chip na status bar)
- Distribuição: JetBrains + Open VSX + forks do VS Code

**Secundário / mínimo**
- Refs de página de PDF · refs de saída de terminal
- Chrome browser automation (@browser) · Remote Control
- Comandos diff-review/doctor/config/status/permissions/add-dir/cd
- Worktrees + workflows (batch, deep research)
- Reposição de painel com local lembrado · URI handler `vscode://anthropic.claude-code/...`
- Progresso de processo em background na status bar · drag-to-attach (Shift+drag)
- Autosave antes de read/write · respectGitIgnore · ativação de env Python · third-party providers
- Restricted Mode (workspace trust) · autocomplete do schema de settings
- Notificações de conclusão + terminal bell
- Busca de sessão por palavra/tempo · rename · aba de sessão remota/cloud
- Display dedicado de todos

---

## Nossos extras (só o Cockpit tem)
- **i18n bilíngue pt-BR/en** (host + webview) com troca em runtime, sem reload
- **Trilho de scroll-markers** (minimapa): 1 marcador por prompt do usuário, com hover numerado
- **Estimativa de custo local** por tabela de preço do modelo, rotulada "estimado" quando não há custo real
- **Painel de cache dedicado**: hit-rate, leitura, escrita
- Contadores input/output sempre visíveis + painel de stats colapsável
- **Descoberta de modelo ao vivo** via `/v1/models` + registro do modelo ativo pelo evento init
- Combo de modelo **agrupado** (Aliases / Versões / 1M) + entrada Custom + nomes amigáveis
- **Auto-resume** da última sessão da pasta ao abrir
- **Paste de arquivo como caminho** + leitura autoritativa Unicode no Windows (FileDropList)
- Ícones emoji por ferramenta + render rico por tipo (Bash split, Read gutter, Write/Edit highlight)
- Gutter de número de linha no Read, ao lado do código limpo destacado
- **Tooltips ricos** com badge de ícone colorido (título + descrição)
- Status bar consolidada (dot idle/busy/error + chip do modelo ativo)
- **Diálogo de confirmação elegante** no webview pra apagar sessão (danger, Esc/overlay)
- Detecção de presença/versão do CLI + composer desabilitado + spawn cmd-safe no Windows
- Setting de **caminho custom** do binário `claude`
- **Parser stream-json tolerante** a mudança de versão do CLI
- Alerta de contexto alto (85%)
- Override manual do limite de contexto (auto 1M/200K derivado do modelo ativo)

---

## Itens "prontos mas não ligados" (quick wins)
1. **Limites 5h/7d**: UI das barras existe; falta a fonte (statusline hook → `rate_limits`). Hoje mostra "Não reportado".
2. **Breakdown de contexto**: a estrutura existe no `StatsSnapshot`; falta alimentar via `/context`.
