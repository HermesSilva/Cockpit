# Status da implementação

Atualizado conforme o primeiro ciclo de construção. Acompanha o [plano de execução](plano-de-execucao.md).

## Estado atual: **scaffold funcional, compilando** ✅

`npm run typecheck` e `npm run build` passam limpos. Saída em `dist/`
(`extension.js`, `webview/main.js`, `webview/main.css`).

## O que já existe

### Fundação (Fase 0) — completa
- Manifesto da extensão (`package.json`), build com esbuild (host + webview), tsconfig duplo.
- Scaffold React no webview; tema 100% via `var(--vscode-*)`.
- Detecção de presença/versão do CLI com aviso claro.
- **Scripts de execução em dev sem instalar**: `run-dev.ps1`, `run-dev.cmd`, `.vscode/launch.json` (F5).

### Contrato e parser (Fase 1) — base
- `shared/events.ts`: schema dos eventos `stream-json` (system, assistant, user, result, stream_event, control_request).
- `shared/protocol.ts`: protocolo host↔webview.
- `src/cli/StreamParser.ts`: NDJSON → eventos, tolerante a ruído.
- *Pendente:* congelar o contrato com **fixtures reais** da versão alvo do `claude`.

### Conversa e timeline (Fase 2) — base
- Chat com streaming token a token; markdown leve (blocos de código + inline).
- Timeline de tool calls (cards colapsáveis input/output).
- Blocos de thinking com toggle.
- Stop/interrupção; nova sessão.
- *Pendente:* histórico/retomada de sessões persistido; @-mention; anexos.

### Seleção de modelo e effort (Fase 6 / M2) — implementado
- Seletores de **modelo** e **effort** na UI (`--model` / `--effort` do CLI), aplicados como
  override de sessão em memória (não alteram settings globais); a troca reinicia a sessão do CLI.
- **Modelos: descoberta em camadas** (o CLI não lista modelos):
  1. aliases sempre válidos (`default`/`opus`/`sonnet`/`haiku`);
  2. **modelo ativo** capturado ao vivo do evento `init` (id/variante exatos, ex.: `claude-opus-4-7[1m]`);
  3. **`/v1/models`** quando há credencial de API (`tootega.apiKey` ou `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`);
  4. campo **Custom…** para qualquer id (o CLI valida no spawn).
- Contas de **assinatura** (`apiKeySource: none`) não têm API key → usam (1)+(2)+(4).
- Effort é enum fixo do CLI (`low/medium/high/xhigh/max`), validado contra a v2.1.143.

### Lista de sessões / "contextos existentes" (Fase 2 / C8) — implementado
- `SessionStore` lê `~/.claude/projects/<cwd-encodado>/<id>.jsonl` (encode: `:` `\` `/` → `-`).
- Drawer **Sessões** (botão ☰): lista título (1ª mensagem do usuário), data e nº de mensagens, mais recentes primeiro.
- **Retomar**: clica → carrega o transcript, renderiza o histórico (user/assistant/thinking/tools) e arma `--resume <id>` no próximo envio.
- **Nova sessão** (＋) limpa resume + timeline.
- Validado contra dados reais: encode, ordenação e títulos UTF-8 (acentos corretos).

### Versões de modelo no seletor — implementado
- Seletor agrupado: **Aliases** (latest) + **Versões** (lista curada de ids versionados) + ativo descoberto + Custom.
- Curada cobre o fallback quando `/v1/models` não está acessível (assinatura). O CLI valida no spawn.

### Anexos no composer: colar imagem e arquivo (Fase 2 / C4-C5) — implementado
- **Colar imagem** (screenshot/bitmap sem caminho): anexa como bloco de imagem base64 no `user` message
  (formato `{type:'image',source:{type:'base64',media_type,data}}` — validado: CLI aceita, result success).
  Chips de preview no composer (remover com ✕) e thumbnails na bolha do usuário.
- **Colar arquivo** (qualquer extensão, com caminho): insere o **endereço** no texto —
  **relativo** ao cwd do contexto se estiver dentro dele, senão **absoluto** (resolvido no host com `path.relative`).
  Caminho vem do `File.path` (Electron) ou de `text/uri-list` (`file://…`) como fallback.

### Permissões e interação (Fase 3) — funcional ponta a ponta
- **Habilitação:** spawn com `--permission-prompt-tool stdio` + handshake `initialize` —
  é o que faz o CLI rotear `can_use_tool` em vez de negar silenciosamente em headless.
- **Resposta correta:** `allow` exige `updatedInput` (o CLI valida com Zod); "sempre
  permitir" devolve `updatedPermissions` a partir do `permission_suggestions` do CLI.
- **Modal de permissão** elegante: ícone por ferramenta, preview por tipo (comando Bash,
  arquivo/conteúdo do Write, URL do WebFetch, JSON genérico), Allow / Always allow / Deny,
  atalhos (Ctrl+Enter / Esc).
- **AskUserQuestion** (perguntas/respostas como na GUI oficial): chega como `can_use_tool`;
  janela com **abas por pergunta**, opções como cards, `multiSelect`, opção **"Outro"**
  (texto livre); a resposta volta via `updatedInput.answers` (chaveado pelo texto da pergunta).
- **Plan mode (E6):** `ExitPlanMode` chega como permissão — render do plano em Markdown,
  botões "Aprovar e executar" / "Continuar planejando".
- Painel revela-se sozinho quando o agente pede interação.
- *Pendente:* inline diff lado-a-lado no editor; edição do plano antes de aprovar; checkpoints.

### Estatísticas e consumo (Fase 4) — base sólida
- `src/stats/StatsAggregator.ts`: contexto, cache, custo, tokens.
- Painel com: medidor de contexto (faixas de cor), cache (hit-rate/leitura/escrita),
  custo (sessão/último turno, rótulo "estimado"), tokens (in/out), limites de conta (5h/7d).
- Alerta de contexto > 85%.
- *Pendente:* breakdown real via `/context`; limites 5h/7d via statusline/`/usage`
  (UI já pronta, falta a fonte de dados); gráficos históricos.

### i18n — fundação (P0) completa
- Manifesto localizado: `package.nls.json` + `package.nls.pt-br.json`.
- Runtime do host: `l10n/bundle.l10n.json` + `…pt-br.json` (`vscode.l10n`).
- Webview: catálogos `en` + `pt-BR`, troca em runtime, interpolação `{0}`.
- Comando "Alternar idioma"; segue `vscode.env.language` por padrão.

## Como executar agora

```powershell
./run-dev.ps1
```

Abre uma janela de teste do VS Code com a extensão carregada (sem instalar).
Ícone **Tootega Cockpit** na barra lateral. Requer o `claude` no PATH e autenticado.

## Próximos passos (ordem sugerida)

1. Capturar **fixtures reais** do `stream-json` e validar o parser ponta a ponta.
2. Ligar a **fonte de dados de conta** (statusline hook → limites 5h/7d) — UI já espera.
3. `/context` real para o **breakdown** de contexto.
4. Inline diff + plan mode + checkpoints (Fase 3/5).
5. Persistência e retomada de sessões.
