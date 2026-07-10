# Changelog

Todas as mudanças notáveis desta extensão são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e o projeto adota versionamento semântico.

## [1.0.212] - 2026-07-10

### Melhorado
- **Título das sessões estilo web.** O card de contexto prioriza o `ai-title`
  gerado pela CLI (o mesmo rótulo curto que o picker do `/resume` mostra). Quando a
  sessão ainda não tem `ai-title`, o *fallback* passa a truncar o 1º prompt do
  usuário (1ª sentença/linha, ~60 chars + `…`) em vez de despejar o parágrafo cru —
  a lista fica legível como no histórico da versão web. Sem gasto de tokens: só
  reflete o que a CLI já produz.

## [1.0.211] - 2026-07-10

### Corrigido
- **DASE MCP colidia entre janelas do VS Code.** Cada janela subia o servidor MCP do
  DASE na mesma porta fixa (`39100`) e gravava o mesmo `mcp-endpoint.json`, então a 2ª
  janela falhava com `EADDRINUSE` e o arquivo de descoberta era sobrescrito. Agora o
  DASE usa porta efêmera (uma por janela) e grava um discovery por janela marcado com o
  `workspacePath`; o Cockpit casa o endpoint com a **própria janela** (normalizado —
  case-insensitive no Windows), caindo no arquivo legado como *fallback*. Requer o DASE
  com a mudança correspondente. `readDaseEndpoint` / `ensureDaseMcpConfig` /
  `registerDaseInClaudeCli` passam a receber o `workspacePath`.

## [1.0.208] - 2026-07-10

### Corrigido
- **Tarefa em background ficava "executando" para sempre.** O card *Running in the
  background* e o spinner de turno (chat e Hub) nunca desligavam depois de um comando
  lançado com `run_in_background`. O acompanhamento lia o texto `<task-notification>`
  das mensagens `user`, mas quando a tarefa termina **com um turno em voo** a CLI
  enfileira a notificação e ela nunca chega ao stdout como mensagem — só como evento
  `system`. Tarefa encerrada pelo agente (`TaskStop`) também nunca notificava. O estado
  passa a ser reconciliado contra o `background_tasks_changed` (lista completa do que
  roda agora, emitida pelo engine), com `task_started` / `task_updated` /
  `task_notification` como complemento; a chave agora é o `task_id` do engine.
- Turno iniciado **pela própria CLI** para reagir à conclusão de uma tarefa em
  background com a sessão ociosa não era contabilizado: com `busy` desligado, o `result`
  caía no descarte "stray/replay" e seus tokens/custo sumiam das estatísticas.

## [1.0.207] - 2026-07-10

### Adicionado
- O Cockpit passa a **registrar o servidor MCP do DASE na configuração de usuário
  do Claude Code CLI** (`~/.claude.json`, escopo user) assim que detecta a extensão
  DASE instalada e o servidor no ar — equivalente a `claude mcp add --scope user`,
  sem o cold start da CLI. Antes, o DASE só era visível às abas do Cockpit com o
  toggle ligado (via `--mcp-config`); agora as tools `dase_*` valem para qualquer
  sessão `claude`, inclusive no terminal e em outros workspaces. A entrada é
  reescrita quando o servidor do DASE reinicia com um endpoint novo. A gravação é
  atômica, preserva as demais chaves e os outros servidores MCP, e nunca registra
  o token em log. Controlado pelo setting `tootega.dase.registerInCli` (padrão ligado).

### Alterado
- O endpoint do DASE passa a aceitar **servidor sem token**: o cabeçalho
  `Authorization` só é enviado quando o `mcp-endpoint.json` traz um token.

## [1.0.204] - 2026-07-10

### Adicionado
- Seção **Para onde foram os tokens** no modal Usage: parcela do uso gerada com
  contexto acima de 150k, parcela vinda de subagentes, aproveitamento do cache e
  **contexto injetado por ferramenta** (servidores MCP agrupados como `mcp:<servidor>`,
  skills como `skill:<nome>`). Os tokens dos `tool_result` são estimados a ~4
  caracteres por token; o vínculo `tool_use` → `tool_result` só existe dentro do
  mesmo arquivo de transcript, e o que fica fora não é atribuído.
- Aviso quando o Claude Code CLI é anterior à **2.1.162**, versão que corrigiu o
  Esc (interromper) ser descartado no início do turno em sessões `stream-json` — o
  canal do Cockpit. Abaixo disso, o botão de parar pode falhar sem aviso.

### Corrigido
- **Uso local inflado (~59% a mais).** Uma resposta do assistant vira várias linhas
  no `.jsonl` (um bloco de texto, um por `tool_use`) e todas repetem o mesmo objeto
  `usage`; a soma linha a linha contava o mesmo consumo até 3–4 vezes. A `usage`
  passa a ser contada uma vez por resposta (`message.id` + `requestId`). O rollup
  de tokens diários foi versionado para descartar o cache já inflado.
- Janelas de limite: a API `/api/oauth/usage` trocou os campos fixos
  `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet` por um array `limits[]`
  com `kind` = `session` | `weekly_all` | `weekly_scoped` e o nome do modelo em
  `scope.model.display_name`. Os campos antigos vêm `null`, então o medidor semanal
  por modelo havia sumido da interface. Agora as janelas escopadas são lidas do
  array e **rotuladas pelo servidor** (hoje, Fable). Os campos legados seguem
  aceitos como fallback.

### Alterado
- Medidores renomeados conforme a nomenclatura atual do Claude Code: "Sessão (5h)"
  passa a ser **Sessão atual** e "Semanal (7 dias)", **Semanal · todos os modelos**.
- O modo de permissão `default` agora é exibido como **Manual**, acompanhando a
  renomeação feita no CLI (2.1.131). O valor interno segue `default` (= sem a flag
  `--permission-mode`), compatível com CLIs anteriores.
- No detalhamento por modelo, o número em destaque passa a ser o de **tokens novos**
  (entrada + saída + escrita de cache). O **cache relido** — que sozinho responde por
  ~97% do total — aparece numa linha secundária, e a nota deixa explícito que o valor
  em USD é o preço-API equivalente, não uma cobrança da assinatura.
- Entradas `<synthetic>` (marcador do CLI para turnos sem chamada real) não aparecem
  mais como se fossem um modelo no detalhamento.

## [1.0.202] - 2026-07-06

### Corrigido
- Caixa de prompt não perde mais o foco ao voltar de outro aplicativo: o webview do
  VSCode blurava o textarea logo após o clique de reativação da janela. O composer
  agora rearma o foco quando a janela volta — se o textarea estava focado ao sair e o
  usuário não focou outro controle.

## [1.0.198] - 2026-07-03

### Adicionado
- Prompts do usuário na timeline agora começam **encolhidos** (cabeçalho + 1 linha),
  com botão **Mostrar mais / Mostrar menos** para expandir e contrair.

### Corrigido
- Tarefas em background (PowerShell/Bash com `run_in_background`, Workflow) não somem
  mais da lista "Running in the background" após concluírem: a notificação de conclusão
  da CLI passa a ser reconhecida também quando chega como bloco `text` em array ou
  embutida no `content` de um `tool_result` (antes só string era tratada).
- Botão de copiar do bloco de código, além dos botões de copiar / rebobinar /
  mostrar-mais do cabeçalho, deixam de ficar cobertos pela caixa de título do tooltip,
  que impedia o clique em copiar (elevados acima do tooltip no empilhamento).

## [1.0.190] - 2026-07-02

### Adicionado
- Inventário de MCP/plugins: agrupamento de tools por servidor MCP a partir do
  evento `system/init` do CLI.
- Comandos **Tootega: Set/Remove Anthropic API key** para gerenciar a API key de
  descoberta de modelos.

### Alterado
- API key de descoberta de modelos migrada da setting `tootega.apiKey` (texto plano)
  para o **SecretStorage** (keychain do SO). Migração automática na primeira ativação;
  a setting é removida.
- Checkbox **DASE (ORM)** agora aparece apenas quando a extensão `tootega.dase` está
  instalada.

### Corrigido
- Elimina sessão-fantasma que ressurgia no Hub após apagar contextos.
- Ativa a extensão DASE para subir o servidor MCP sem `.dsorm` no workspace.
- Corrige crash do extension host por tempestade de reload de webview.

### Publicação
- Preparação para o VS Code Marketplace: aviso de não-afiliação com a Anthropic,
  `.vscodeignore` enxuto (remove scripts de dev e notas internas do pacote) e
  atribuição de licenças de terceiros (ver `THIRD-PARTY-NOTICES.md`).

## [1.0.0] - 2026-06

### Adicionado
- Primeira versão pública: chat com streaming, timeline de tools, diffs,
  checkpoints, painel de estatísticas/consumo, permissões, plan mode,
  ditado por voz, corretor ortográfico bilíngue e i18n pt-BR/en.
