# Plano de Execução

**Produto:** Tootega Cockpit for Claude Code *(nome provisório)*
**Autoria:** Tootega Pesquisa e Inovação · **Licença:** MIT
**Documento companheiro:** [../CLAUDE.md](../CLAUDE.md)

---

## 0. Objetivo do documento

Definir **o quê**, **em que ordem** e **com qual critério de pronto** construir a extensão. O alvo não é "mais um chat de IA no VSCode", e sim a **GUI mais transparente e controlável** para o Claude Code: tudo que o CLI sabe sobre **contexto, cache, custo e limites da conta** fica visível e acionável na tela.

---

## 1. Visão e princípios

1. **A UI é cliente do CLI.** Zero reimplementação de orquestração (ver CLAUDE.md §1).
2. **Transparência radical de consumo.** Contexto, cache, custo e limites são cidadãos de primeira classe — não um rodapé.
3. **Controle humano configurável.** Do "aprovo cada passo" ao "deixa rodar", o usuário escolhe.
4. **Degradação graciosa.** Versões diferentes do CLI não podem quebrar a UI; eventos desconhecidos são ignorados.
5. **Nativo ao VSCode.** Tema, atalhos, diff e ergonomia seguem a casa.
6. **Bilíngue desde o dia 1.** pt-BR e inglês internacional; i18n é fundação, não verniz final (ver §4.7).

---

## 2. Arquitetura de execução

### 2.1. Processo e canais

| Canal | Mecanismo | Conteúdo |
|-------|-----------|----------|
| Motor → UI | `claude -p --output-format stream-json --verbose` (stdout NDJSON) | mensagens, thinking, tool_use, tool_result, usage, eventos de sessão |
| UI → Motor | `--input-format stream-json` (stdin) | mensagens do usuário, respostas a perguntas, decisões de permissão |
| Sessão | `--resume <id>` / `--continue` | retomar conversas |
| Stats/conta | hook de **statusline** (JSON) | `model`, `context_window`, `cost`, `rate_limits.limits[]` (`session`, `weekly_all`, `weekly_scoped`), `workspace` |
| Stats sob demanda | `/usage`, `/context`, `/cost` | breakdown de contexto, custo, limites |
| Persistência | `~/.claude/` (sessões, settings, projetos) | histórico, configs, CLAUDE.md |

### 2.2. Componentes internos

- **CliProcessManager** — spawn, ciclo de vida, retry, detecção de versão/capabilities do `claude`.
- **StreamParser** — NDJSON → eventos tipados; tolerante a desconhecidos.
- **SessionStore** — estado da sessão, histórico, mapeamento mensagem→checkpoint.
- **StatsAggregator** — acumula usage por turno/sessão; calcula cache hit-rate, custo, pacing.
- **AccountPoller** — lê statusline/`/usage` para limites 5h/7d e plano.
- **PermissionBroker** — implementa o lado-cliente de Allow/Deny e plan mode.
- **DiffService** — ponte com a API de diff do VSCode.
- **WebviewBridge** — `postMessage` tipado entre host e React.

### 2.3. Contrato de eventos (a especificar na Fase 1)

> Antes de codar, **mapear o esquema real** dos eventos `stream-json` da versão alvo do `claude` e congelar um contrato versionado (`schemas/`). Tudo que a UI consome passa por esse contrato.

---

## 3. Roteiro por fases (marcos)

Cada fase tem **entrada**, **entregáveis** e **critério de pronto (DoD)**.

### Fase 0 — Fundação *(P0)*

**Entrada:** repositório vazio (atual).
**Entregáveis:**
- Scaffold da extensão (TS) + webview (React/Vite).
- **Infra de i18n montada já no scaffold**: `vscode.l10n` no host, camada de i18n no webview, `l10n/` com `pt-BR` + `en` (base). Toda string nasce como chave.
- `CliProcessManager` faz spawn do `claude` e captura stdout/stderr.
- "Hello world": enviar um prompt e renderizar a resposta em texto puro.
- Detecção de presença e versão do CLI; mensagem clara se ausente.

**DoD:** uma pergunta vai ao CLI e a resposta aparece no webview, com streaming; a UI inicial já alterna pt-BR/en sem texto hardcoded.

---

### Fase 1 — Contrato e parser *(P0)*

**Entregáveis:**
- `schemas/` com o esquema dos eventos `stream-json` (mensagem, thinking, tool_use, tool_result, usage, sessão).
- `StreamParser` cobrindo todos os tipos conhecidos + fallback gracioso.
- Testes de parsing com fixtures reais capturadas do CLI.

**DoD:** stream completo de uma sessão real é parseado sem perdas e com 100% de cobertura dos tipos mapeados.

---

### Fase 2 — Conversa e timeline *(P0)*

**Features:** C1, C3, C6, C8, P1, P2.
**Entregáveis:**
- Chat com streaming, markdown rico, syntax highlight.
- Timeline de tool calls (cards colapsáveis input/output).
- Stop/interrupção.
- Lista e retomada de sessões.
- Tema sincronizado com VSCode.

**DoD:** dá pra conduzir uma sessão real de ponta a ponta, ver as tools rodando, interromper e retomar depois.

---

### Fase 3 — Edição, diff e permissões *(P0)*

**Features:** E1, E3, E6, K1.
**Entregáveis:**
- Inline diff antes de gravar (API de diff do VSCode).
- `PermissionBroker`: Allow/Deny/Allow-always renderizado como modal bloqueante.
- Plan mode: exibir e aprovar plano.
- Checkpoint automático antes de mudanças.

**DoD:** o agente edita arquivos só após aprovação; plano é revisável; é possível desfazer via checkpoint.

---

### Fase 4 — Painel de estatísticas e consumo *(P0/P1) — diferencial central*

**Features:** S1, S4, S6, S8 (P0) → S2, S3, S5, S9 (P1).
**Entregáveis:**
- **Medidor de contexto** sempre visível: usado / restante / limite, com cor por faixa.
- **Breakdown de contexto** (system, tools, MCP, mensagens, arquivos, todos, thinking) — via `/context`.
- **Cache**: escrita, leitura, hit-rate, economia estimada.
- **Custo**: por request, sessão e acumulado (tokens + $).
- **Limites da conta**: janelas 5h e 7d, % usado, horário de reset — via `rate_limits`.
- **Barra de status do agente**: modelo, effort, modo, workspace.
- **Alertas**: contexto perto do limite, compactação iminente, limite de plano próximo.

**DoD:** em qualquer momento o usuário sabe, sem sair da tela: quanto de contexto resta, quanto gastou (tokens e $), quanto do cache foi aproveitado, e quanto falta para o limite da assinatura resetar.

---

### Fase 5 — Recuperação e controle fino *(P1)*

**Features:** K2, K3, K4, E2, E4, E5, E8.
**Entregáveis:**
- Rewind por mensagem; 3 modos de restore (Files / Files Only / Files & Task).
- Aceitar/rejeitar por arquivo e por hunk.
- Modo HITL ↔ Agent-first (auto-approve configurável) + allow/denylist de tools.
- Painel de Todos do agente.

**DoD:** o usuário transita livremente entre "reviso tudo" e "deixa rodar", e consegue voltar a qualquer ponto da história com o modo de restore certo.

---

### Fase 6 — Extensibilidade *(P1)*

**Features:** X1, X2, X3, X4, X6, X7, M2.
**Entregáveis:**
- Slash commands (built-in + custom) com autocomplete.
- Skills e subagentes: listar e acionar.
- MCP: status e tools por servidor.
- Editor de `CLAUDE.md`/settings com validação; gestão de permissões persistidas.
- Seletor de modelo e effort.

**DoD:** tudo que o CLI expõe de extensibilidade é alcançável pela GUI, sem ir ao terminal.

---

### Fase 7 — Diferenciais e polish *(P2)*

**Features:** C7, C9, C10, E7, S7, S10, S11, M1, M3, M4, M5, M6, P3, P4, P5.
**Entregáveis:**
- Fila de mensagens; threads de subagentes; sort de sessões por custo/token.
- Gráficos históricos de consumo; indicador de pacing.
- Modos por papel; memória de projeto; abas/sessões múltiplas; worktrees.
- Atalhos completos; densidade configurável. *(i18n já é fundação desde a Fase 0 — ver §4.7.)*

**DoD:** experiência "fenomenal" — a UI vira a forma preferida de usar o Claude Code, não um substituto pobre do terminal.

---

## 4. Requisitos detalhados — Estatísticas, Contexto, Cache e Consumo

> Esta seção expande o pedido central: **tudo** que o CLI permite sobre consumo deve estar na tela.

### 4.1. Janela de contexto (S1, S2)

- **Indicador principal:** barra usado/restante com limite explícito (200K ou 1M conforme modelo), em tokens e %.
- **Breakdown** (do `/context`), uma linha por categoria com tokens e %:
  - System prompt · Tools/definições · Servidores MCP · Mensagens (histórico) · Arquivos anexados · Todos · Blocos de thinking · Reservado para resposta.
- **Estados visuais:** verde < 60% · amarelo 60–85% · vermelho > 85% · pulsa quando compactação está iminente.

### 4.2. Cache (S3, S5)

- Campos por turno (do `usage`): `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`, `output_tokens`.
- **Métricas derivadas:** hit-rate de cache `read / (read + write + input)` — os writes são *misses* (gravados a ~1,25×), por isso entram no denominador; economia estimada (read a ~0,1× vs. input cheio), custo de escrita (~1,25×).
- Sinalizar **cache frio** (0 reads repetidos) como possível invalidador silencioso.

### 4.3. Custo (S4)

- Por **request**, por **sessão** e **acumulado** — em tokens e em $ (estimado pela tabela de preços do modelo ativo).
- Detalhar por categoria de token (input, output, cache-create, cache-read), já que cada uma tem preço distinto.
- Origem: agregação dos eventos `usage` + campo `cost` da statusline.

### 4.4. Limites da assinatura / conta (S6, S7)

- **Janelas** vindas de `limits[]` (`rate_limits` da statusline / `/usage`): `session` (sessão atual), `weekly_all` (semanal, todos os modelos) e `weekly_scoped` (semanal por modelo, rotulada por `scope.model.display_name` — ex.: Fable). Para cada uma: % usado, valor absoluto e **horário de reset**. Campos legados `five_hour`/`seven_day`/`seven_day_<modelo>` seguem aceitos como fallback.
- **Pacing:** ritmo atual de consumo projetado contra o reset — alerta se o usuário "vai bater o teto" antes da janela virar.
- Exibir **plano** da assinatura quando disponível.

### 4.5. Estado do agente (S8, S9, S11)

- Barra persistente: modelo, effort, modo (plan/normal), workspace/branch.
- Alertas não intrusivos: contexto > 85%, compactação iminente/ocorrida (quanto foi condensado — S11), limite de plano próximo.

### 4.6. Histórico (S10)

- Gráfico de consumo por sessão e diário (tokens e $), reaproveitando transcripts em `~/.claude/`.

> **Nota de fidelidade:** todos os números vêm do CLI/conta; a UI **não estima** o que pode ler. Onde só houver estimativa (ex.: $ a partir de tokens), rotular como estimativa.

### 4.7. Internacionalização (i18n) — requisito de fundação

- **Locales:** `pt-BR` e `en` (**inglês internacional**, neutro: sem gírias/regionalismos US ou UK; datas, números e moeda formatados pelo locale).
- **Idioma padrão:** segue `vscode.env.language`; fallback `en` para locales não suportados; override manual nas settings da extensão.
- **Cobertura total:** UI, mensagens de erro, tooltips, comandos, notificações, alertas de consumo, rótulos de stats. Zero string hardcoded.
- **Troca em runtime** sem reload.
- **Estrutura:** `l10n/bundle.l10n.json` (base inglês) + `l10n/bundle.l10n.pt-br.json`; host via `vscode.l10n.t()`, webview via camada equivalente sincronizada por `postMessage`.
- **Pluralização e interpolação** pela camada de i18n — proibido concatenar strings.
- **DoD de i18n:** auditoria automatizada falha o build se houver string visível sem chave; ambos os locales 100% cobertos.

---

## 5. Riscos e mitigação

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Esquema do `stream-json` mudar entre versões | Quebra de parsing | Contrato versionado + parser tolerante + testes com fixtures por versão |
| Dados de conta (limites 5h/7d) não expostos programaticamente | Lacuna em S6 | Usar statusline hook como fonte; fallback para `/usage`; degradar com aviso |
| Custo em $ impreciso | Confiança do usuário | Rotular como estimativa; basear na tabela de preços do modelo ativo |
| Paridade com a extensão oficial (alvo móvel) | Esforço perpétuo | Focar no diferencial (consumo/controle), não em clonar 1:1 |
| Permissões/segurança | Risco real | Nunca burlar prompts; respeitar o modelo do CLI; não logar segredos |

---

## 6. Critérios de qualidade (transversais)

- **Performance:** UI fluida com sessões longas (virtualização de listas, throttle de render no streaming).
- **Resiliência:** queda do processo `claude` é detectada e recuperável sem perder histórico.
- **Acessibilidade:** navegável 100% por teclado; contraste respeitando o tema.
- **Testes:** parser e agregadores cobertos por unit; fluxos críticos por integração.
- **i18n:** pt-BR como idioma primário.

---

## 7. Próximos passos imediatos

1. Confirmar **nome** do produto e ID da extensão.
2. Capturar **fixtures reais** do `stream-json` da versão alvo do `claude` (entrada da Fase 1).
3. Validar a disponibilidade programática dos campos de **conta/limites** (statusline vs. `/usage`).
4. Scaffold da Fase 0.

> Decisões abertas devem ser registradas neste documento conforme forem fechadas.
