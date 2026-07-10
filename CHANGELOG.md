# Changelog

Todas as mudanças notáveis desta extensão são documentadas aqui.
O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/)
e o projeto adota versionamento semântico.

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
