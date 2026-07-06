// Um runtime de conversa: encapsula um processo do CLI, suas estatísticas e
// todo o estado de streaming. Emite mensagens de UI por um callback (o provider
// as etiqueta com o id da aba e encaminha ao webview). Várias instâncias rodam
// em paralelo — uma por aba.
import { CliProcessManager } from '../cli/CliProcessManager';
import { StatsAggregator } from '../stats/StatsAggregator';
import { loadStats, saveStats } from '../stats/StatsStore';
import { log, dlog } from '../util/logger';
import type {
  ClaudeEvent,
  AssistantEvent,
  UserEvent,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../shared/events';
import type { HostToWebview, LimitWindow } from '../../shared/protocol';

export interface SessionHooks {
  emit: (msg: HostToWebview) => void;
  onBusy: (busy: boolean) => void;
  onResult: () => void;
  onInteraction: () => void;
  onInit: (model?: string, slashCommands?: string[]) => void;
  onAuthRequired: () => void;
  // Turno encerrou de forma anormal: o host localiza e mostra o aviso na aba.
  //  - 'aborted': o processo do CLI morreu no meio do turno (sem result).
  //  - 'error':   o CLI reportou um result de erro (texto da própria CLI).
  //  - 'transient': queda/stall (CLI re-tenta); aviso brando.
  onTurnError?: (info: { kind: 'aborted' | 'error' | 'transient'; code?: number | null; text?: string }) => void;
  fileText: (tool: string, input: unknown) => string | undefined;
  // Cada tool_use (antes da execução): permite autosave de arquivos read/write.
  onToolUse?: (tool: string, input: unknown) => void;
  claudePath: () => string;
  cwd: () => string;
  // Defaults vindos das settings (o que 'default' resolve quando não há override).
  // `daseModel` = modelo preferido p/ sessões com a integração DASE ligada
  // ('default' = sem override; usa o `model`).
  settings: () => { model: string; effort: string; permission: string; allowAgents: boolean; daseModel: string };
  // Caminho do `--mcp-config` do DASE (ou undefined se indisponível). Consultado
  // só quando a aba liga a integração — assim as tools só pesam quando pedidas.
  mcpConfigPath?: () => string | undefined;
  // Idioma (código curto: pt, en…) p/ as perguntas do agente (AskUserQuestion).
  askLanguage: () => string;
}

export class Session {
  cli?: CliProcessManager;
  stats: StatsAggregator;
  resumeId?: string;
  busy = false;
  slashCommands: string[] = [];
  sessionId?: string;

  // Tarefas em background ainda rodando (Workflow / tool com run_in_background).
  // O turno que as lança termina (`result` zera o busy), mas o trabalho continua;
  // a conclusão chega depois como um `user` com `<task-notification>`. Mantemos o
  // indicador de "executando" vivo enquanto este mapa não esvaziar. Chave = tool_use
  // id que lançou; valor = {tool, label} do que está fazendo (mostrado ao usuário).
  private bgTasks = new Map<string, { tool: string; label: string }>();

  // Overrides POR ABA (em memória). Vazio = usa o default das settings.
  modelOverride?: string;
  effortOverride?: string;
  permissionOverride?: string;
  // Liberar agentes (Task) e workflows (Workflow). undefined = usa o default das settings.
  allowAgentsOverride?: boolean;
  // Integração DASE (servidor MCP do ORM Designer) ligada nesta aba. Opt-in:
  // quando ligada, injeta o --mcp-config do DASE e (se houver) troca p/ o modelo
  // de integração. Default OFF — sem custo de contexto das tools.
  daseEnabledOverride?: boolean;

  // Estado de streaming
  private currentAssistantId?: string;
  private streamedText = new Set<string>();
  private blockKind = new Map<number, string>();
  private toolBuffers = new Map<number, { id: string; name: string; json: string }>();
  private emittedTools = new Set<string>();
  private pendingPerm = new Map<string, { tool: string; input: unknown; suggestions?: unknown[] }>();

  constructor(private hooks: SessionHooks) {
    this.stats = new StatsAggregator(0);
  }

  // ---- ciclo de vida ----

  // Valores efetivos (override da aba ?? default das settings).
  model(): string {
    if (this.modelOverride) return this.modelOverride;
    // Integração DASE ligada: usa o modelo de integração (econômico) quando
    // configurado, salvo override explícito da aba acima.
    if (this.daseEnabled()) {
      const dm = this.hooks.settings().daseModel;
      if (dm && dm !== 'default') return dm;
    }
    return this.hooks.settings().model;
  }
  effort(): string {
    return this.effortOverride ?? this.hooks.settings().effort;
  }
  permission(): string {
    return this.permissionOverride ?? this.hooks.settings().permission;
  }
  allowAgents(): boolean {
    return this.allowAgentsOverride ?? this.hooks.settings().allowAgents;
  }
  daseEnabled(): boolean {
    return this.daseEnabledOverride ?? false;
  }

  setModel(m: string): void {
    this.modelOverride = m;
    this.stop();
  }
  setEffort(e: string): void {
    this.effortOverride = e;
    this.stop();
  }
  setPermission(p: string): void {
    this.permissionOverride = p;
    this.stop();
  }
  setAllowAgents(v: boolean): void {
    this.allowAgentsOverride = v;
    this.stop();
  }
  setDaseEnabled(v: boolean): void {
    this.daseEnabledOverride = v;
    this.stop(); // respawna o CLI com/sem o --mcp-config do DASE
  }

  ensureCli(): void {
    if (this.cli) return;
    const model = this.model();
    const effort = this.effort();
    this.cli = new CliProcessManager({
      claudePath: this.hooks.claudePath(),
      cwd: this.hooks.cwd(),
      model: model && model !== 'default' ? model : undefined,
      effort: effort && effort !== 'default' ? effort : undefined,
      permissionMode: this.permission(),
      // Bloqueia subagentes/workflows quando desligado (economia de tokens).
      disallowedTools: this.allowAgents() ? undefined : ['Task', 'Workflow'],
      // DASE só entra quando a aba pede (opt-in) E o endpoint existe. Sem isto,
      // as ~40 tools do DASE não entram no contexto.
      mcpConfigPath: this.daseEnabled() ? this.hooks.mcpConfigPath?.() : undefined,
      // resumeId ?? sessionId: defesa contra qualquer caminho que conheça o
      // sessionId mas não tenha fixado o resumeId — evita spawn sem --resume
      // (que duplicaria o contexto). clearConversation() zera ambos p/ nova conversa.
      resumeSessionId: this.resumeId ?? this.sessionId,
      askLanguage: this.hooks.askLanguage(),
    });
    this.cli.on('event', (e: ClaudeEvent) => this.onCliEvent(e));
    this.cli.on('stderr', (t: string) => {
      log(`[cli stderr] ${t.trim()}`);
      if (isAuthError(t)) this.hooks.onAuthRequired();
    });
    this.cli.on('exit', (code) => {
      log(`CLI exited (${code})`);
      // Morte no meio de um turno (busy ainda ligado = não foi stop()/interrupt(),
      // que zeram busy antes): o processo abortou sem emitir `result`. Sem aviso, o
      // indicador some e o usuário acha que ainda roda. Finaliza e avisa.
      const abortedMidTurn = this.busy;
      if (abortedMidTurn) {
        if (this.currentAssistantId) this.emit({ kind: 'assistantDone', id: this.currentAssistantId });
        this.stats.endTurn();
        this.persist();
        this.resetStreamingState();
      }
      this.setBusy(false);
      this.resetBgTasks(); // processo morto → nenhuma tarefa em background sobrevive
      if (abortedMidTurn) {
        this.hooks.onTurnError?.({ kind: 'aborted', code });
        this.emit({ kind: 'stats', stats: this.stats.snapshot() });
      }
    });
    this.cli.start();
  }

  send(text: string, images?: { mediaType: string; data: string }[]): void {
    this.ensureCli();
    this.setBusy(true);
    this.stats.beginTurn(); // cronômetro do tempo de execução ativo (sem ociosidade)
    // Estado ANTES do turno: principalmente o cache (idade/vida), p/ entender o
    // que cada prompt encontra (cache quente vs. frio = re-pagar cacheWrite).
    const s = this.stats.snapshot();
    const cacheState =
      s.cacheExpiresInMs == null
        ? 'frio (sem turno anterior)'
        : s.cacheAlive
          ? `quente, expira em ${(s.cacheExpiresInMs / 60_000).toFixed(1)}m (idade ${((s.cacheAgeMs ?? 0) / 60_000).toFixed(1)}m)`
          : `VENCIDO há ${((-(s.cacheExpiresAt ?? 0) + Date.now()) / 60_000).toFixed(1)}m → re-cache neste turno`;
    log(
      `[session] send (${this.sessionId ?? this.resumeId ?? 'nova'}): ${text.length} chars, ${images?.length ?? 0} img | ` +
        `ctx=${s.contextUsed}/${s.contextLimit} | cache: ${cacheState} | ` +
        `hit=${(s.cacheHitRate * 100).toFixed(0)}%${s.lastTurnHitRate != null ? ` (últ. ${(s.lastTurnHitRate * 100).toFixed(0)}%)` : ''} read=${s.cacheReadTokens} write=${s.cacheCreateTokens} resets=${s.cacheResetCount ?? 0} | ` +
        `custo=$${s.sessionCostUsd.toFixed(4)}${s.costIsEstimate ? '~' : ''} turnos=${s.turnCount ?? 0}`,
    );
    this.cli!.sendUserMessage(text, images);
  }

  interrupt(): void {
    this.cli?.interrupt();
    this.stats.endTurn();
    this.persist();
    this.setBusy(false);
    this.resetBgTasks(); // interromper mata o processo → tarefas em background morrem
    dlog('session', `interrupt (${this.sessionId ?? '?'})`);
  }

  /** Encerra o processo; mantém as estatísticas. A próxima mensagem respawna. */
  stop(): void {
    this.resetStreamingState();
    this.pendingPerm.clear();
    this.stats.endTurn(); // fecha o turno em voo (não conta ocioso depois)
    this.persist();
    if (this.cli) dlog('session', `stop (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli?.stop();
    this.cli = undefined;
    this.setBusy(false);
    this.resetBgTasks();
  }

  /** Limpa a conversa por completo (novo/retomar): zera estatísticas também. */
  clearConversation(): void {
    this.stop();
    this.sessionId = undefined;
    // Limpa também o resumeId: conversa REALMENTE nova. Sem isto, após "limpar
    // contexto" numa sessão retomada o próximo send() respawnaria com --resume da
    // sessão antiga (não limparia) — e o pinning do init deixaria esse id grudado.
    this.resumeId = undefined;
    this.stats = new StatsAggregator(0);
  }

  resume(sessionId: string): void {
    this.clearConversation();
    this.resumeId = sessionId;
    // Hidrata os acumuladores persistidos: a sessão CONTINUA coerente (o CLI não
    // re-emite o usage dos turnos antigos no --resume).
    const persisted = loadStats(sessionId);
    if (persisted) this.stats.hydrate(persisted);
    this.stats.markReopen(); // contador de reaberturas do contexto
    const snap = this.stats.snapshot();
    dlog(
      'session',
      `resume ${sessionId}: ${persisted ? 'hidratado' : 'sem stats salvos'}, reopen=${snap.reopenCount}, ctx=${snap.contextUsed}, turnos=${snap.turnCount}, cacheAlive=${snap.cacheAlive ?? false}`,
    );
    this.emit({ kind: 'stats', stats: this.stats.snapshot() }); // restaura a barra de imediato
    this.emitTimeline();
  }

  /** Persiste as estatísticas desta sessão (debounced/atômico). Requer sessionId. */
  private persist(): void {
    const id = this.sessionId ?? this.resumeId;
    if (id) saveStats(this.stats.serialize(id, this.hooks.cwd()));
  }

  /**
   * Ping de keep-alive pelo CLI VIVO desta sessão (não por --resume paralelo, que
   * conflitaria com o processo aberto). Reutiliza o fluxo normal de turno: o
   * `result` fecha o cronômetro e persiste o lastTurnTs → reinicia a vida do cache.
   * Devolve false se ocupado (turno em andamento já mantém o cache quente).
   */
  keepAlivePing(): boolean {
    if (this.busy) return false;
    this.ensureCli();
    this.setBusy(true);
    this.stats.beginTurn();
    dlog('session', `keep-alive ping (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli!.sendUserMessage('keep-alive: responda apenas "ok". Não use ferramentas nem altere arquivos.');
    return true;
  }

  /** Liga/desliga o keep-alive de cache deste contexto e persiste o estado. */
  setKeepCacheAlive(value: boolean): void {
    this.stats.setKeepCacheAlive(value);
    this.persist();
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    dlog('session', `keepCacheAlive=${value} (${this.sessionId ?? this.resumeId ?? '?'})`);
  }

  /** Envia a timeline/compactações (pesado) — por turno, não por token. */
  private emitTimeline(): void {
    const { timeline, compactions } = this.stats.timelineSnapshot();
    this.emit({ kind: 'statsTimeline', timeline, compactions });
  }

  applyLimits(limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow }, source: 'real' | 'estimate'): void {
    this.stats.setLimits(limits, source);
  }

  snapshot() {
    return this.stats.snapshot();
  }

  /** Reenvia a timeline/compactações desta sessão (ao trocar/abrir a aba). */
  sendTimeline(): void {
    this.emitTimeline();
  }

  // ---- protocolo de controle (permissão / AskUserQuestion) ----

  decide(requestId: string, decision: 'allow' | 'deny' | 'allow_always', message?: string): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    if (pend?.tool) {
      // Em negações, registra a razão (feedback do usuário) no log de negações.
      this.stats.recordDecision(pend.tool, decision, decision === 'deny' ? message : undefined);
      this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    }
    if (decision === 'deny') {
      // `message` = feedback do usuário (ex.: notas no plan mode editável).
      this.cli?.sendControlResponse(requestId, {
        behavior: 'deny',
        message: message?.trim() || 'Denied by user',
      });
      return;
    }
    const resp: Record<string, unknown> = { behavior: 'allow', updatedInput: pend?.input ?? {} };
    if (decision === 'allow_always' && pend?.suggestions?.length) {
      resp.updatedPermissions = pend.suggestions;
    }
    this.cli?.sendControlResponse(requestId, resp);
  }

  answer(requestId: string, answers: Record<string, string>): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    const base = (pend?.input as Record<string, unknown>) ?? {};
    this.cli?.sendControlResponse(requestId, {
      behavior: 'allow',
      updatedInput: { ...base, answers },
    });
  }

  // ---- internos ----

  private setBusy(b: boolean): void {
    this.busy = b;
    this.hooks.onBusy(b);
  }

  private addBgTask(id: string, tool: string, label: string): void {
    if (this.bgTasks.has(id)) return;
    this.bgTasks.set(id, { tool, label });
    this.emitBackground();
  }

  private clearBgTask(id: string): void {
    if (!this.bgTasks.delete(id)) return;
    this.emitBackground();
  }

  /** Zera o estado de background (parada/limpeza da sessão). */
  private resetBgTasks(): void {
    if (this.bgTasks.size === 0) return;
    this.bgTasks.clear();
    this.emitBackground();
  }

  private emitBackground(): void {
    const tasks = [...this.bgTasks.entries()].map(([id, v]) => ({ id, tool: v.tool, label: v.label }));
    this.emit({ kind: 'background', tasks });
  }

  private emit(msg: HostToWebview): void {
    this.hooks.emit(msg);
  }

  private onCliEvent(ev: ClaudeEvent): void {
    const snap = this.stats.ingest(ev);
    this.emit({ kind: 'stats', stats: snap });

    switch (ev.type) {
      case 'system': {
        const s = ev as any;
        if (s.subtype === 'init') {
          if (Array.isArray(s.slash_commands)) this.slashCommands = s.slash_commands;
          this.sessionId = s.session_id;
          if (s.session_id) {
            this.cli?.setResumeId(s.session_id); // respawn silencioso continua ESTA sessão
            // Fixa o id de retomada no NÍVEL DA SESSÃO: um stop() (troca de
            // model/effort/permission) descarta o CliProcessManager, e o próximo
            // send() respawna via ensureCli() lendo `this.resumeId`. Sem isto, esse
            // respawn subiria SEM --resume e o CLI criaria um .jsonl NOVO — contexto
            // DUPLICADO no Hub. Com isto, continua sempre a mesma sessão.
            this.resumeId = s.session_id;
            this.persist(); // sessionId conhecido: cria/atualiza o arquivo de stats
            dlog('session', `init: sessionId=${s.session_id} model=${s.model ?? '?'} mode=${s.permissionMode ?? '?'}`);
          }

          this.emit({
            kind: 'sessionInit',
            sessionId: s.session_id,
            model: s.model,
            cwd: s.cwd,
            mode: s.permissionMode,
            tools: s.tools,
            mcpServers: s.mcp_servers,
            slashCommands: this.slashCommands,
          });
          this.hooks.onInit(typeof s.model === 'string' ? s.model : undefined, this.slashCommands);
        }
        break;
      }
      case 'stream_event':
        this.onRawStream((ev as any).event);
        break;
      case 'assistant':
        this.onAssistant(ev as AssistantEvent);
        break;
      case 'user':
        this.onUser(ev as UserEvent);
        break;
      case 'control_request': {
        const r = ev as any;
        if (r.request?.subtype === 'can_use_tool') {
          const reqId = r.request_id as string;
          const tool = (r.request.tool_name as string) ?? 'tool';
          const input = r.request.input;
          const suggestions = r.request.permission_suggestions as unknown[] | undefined;
          this.pendingPerm.set(reqId, { tool, input, suggestions });
          this.hooks.onInteraction();
          if (tool === 'AskUserQuestion') {
            const questions = ((input as any)?.questions ?? []) as any[];
            this.emit({ kind: 'askRequest', requestId: reqId, questions });
          } else {
            this.emit({
              kind: 'permissionRequest',
              requestId: reqId,
              tool,
              displayName: r.request.display_name,
              description: r.request.description,
              input,
              suggestions: suggestions as any,
              oldText: this.hooks.fileText(tool, input),
            });
          }
        }
        break;
      }
      case 'control_response': {
        // Resposta do handshake `initialize`: já traz os slash commands ANTES do
        // 1º envio. (O `system init` só chega depois da primeira mensagem.)
        const r = ev as any;
        const resp = r.response;
        const cmds = extractSlashCommands(resp?.response) || extractSlashCommands(resp);
        if (cmds.length && this.slashCommands.length === 0) {
          this.slashCommands = cmds;
          this.emit({ kind: 'slashCommands', commands: cmds });
          this.hooks.onInit(undefined, cmds); // dispara pesquisa IA + grade de contextos
        }
        break;
      }
      case 'result': {
        const r = ev as any;
        // Só conta o que NÓS iniciamos: send()/keepAlivePing() setam busy=true. Um
        // `result` com busy=false é stray/replay (ex.: o CLI re-emite turnos ao
        // `--resume`) — processá-lo inflaria turnos/custo local e poluiria a UI.
        if (!this.busy) {
          dlog('session', `result ignorado (busy=false): stray/replay do CLI`);
          break;
        }
        const errText = String(r.result ?? r.error ?? '').trim();
        if (r.is_error && isAuthError(errText)) {
          this.hooks.onAuthRequired();
        } else if (r.is_error) {
          // Erro reportado pelo CLI no fim do turno. Transitório (queda/stall, CLI
          // 2.1.179+ preserva o parcial) ganha aviso brando; demais, aviso de erro
          // com o texto da própria CLI. Sem isto o turno "morre" sem explicação.
          const transient = isTransientError(errText, r.subtype);
          log(`[session] result ${transient ? 'transitório' : 'erro'} (${this.sessionId ?? '?'}): ${errText.slice(0, 160)}`);
          this.hooks.onTurnError?.({ kind: transient ? 'transient' : 'error', text: errText || undefined });
        }
        this.stats.endTurn(); // fecha o cronômetro do prompt (tempo de execução real)
        {
          const s = this.stats.snapshot();
          log(
            `[session] result (${this.sessionId ?? '?'}): turnos=${s.turnCount}, ctx=${s.contextUsed}/${s.contextLimit}, ` +
              `custo=$${s.sessionCostUsd.toFixed(4)}${s.costIsEstimate ? '~' : ''}, activeMs=${s.activeMs ?? 0}, ` +
              `hit=${(s.cacheHitRate * 100).toFixed(0)}%${s.lastTurnHitRate != null ? ` (últ. ${(s.lastTurnHitRate * 100).toFixed(0)}%)` : ''} read=${s.cacheReadTokens} write=${s.cacheCreateTokens} resets=${s.cacheResetCount ?? 0}`,
          );
        }
        this.emit({ kind: 'turnComplete', costUsd: r.total_cost_usd, usage: r.usage });
        this.emit({ kind: 'stats', stats: this.stats.snapshot() }); // activeMs consolidado
        this.emitTimeline(); // nova amostra de timeline (1x por turno)
        this.persist(); // salva o estado da sessão (continua coerente ao reabrir)
        this.setBusy(false);
        this.hooks.onResult();
        this.resetStreamingState();
        break;
      }
      case 'rate_limit_event':
        this.onRateLimit((ev as any).rate_limit_info);
        break;
    }
  }

  /**
   * Limite de conta vindo do engine no stream. Canal automático (sem statusline):
   * status + reset + janela sempre; % (`utilization`) só perto do limite.
   */
  private onRateLimit(info: any): void {
    if (!info || typeof info !== 'object') return;
    const type = info.rateLimitType ?? info.rate_limit_type;
    const which = type === 'five_hour' ? 'fiveHour' : type === 'seven_day' ? 'sevenDay' : undefined;
    if (!which) return; // seven_day_opus/sonnet/overage: fora das 2 janelas exibidas
    let pct: number | undefined =
      typeof info.utilization === 'number' && Number.isFinite(info.utilization)
        ? info.utilization
        : undefined;
    if (pct != null && pct > 1.5) pct = pct / 100; // defensivo (caso venha 0..100)
    const resetRaw = info.resetsAt ?? info.resets_at;
    let resetsAt: string | undefined;
    if (typeof resetRaw === 'number' && Number.isFinite(resetRaw)) {
      const ms = resetRaw > 1e12 ? resetRaw : resetRaw * 1000;
      try {
        resetsAt = new Date(ms).toISOString();
      } catch {
        /* epoch inválido */
      }
    }
    const status =
      info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected'
        ? info.status
        : undefined;
    this.stats.setStreamLimit(which, { usedPct: pct, resetsAt, status });
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
  }

  private onRawStream(raw: any): void {
    if (!raw || typeof raw.type !== 'string') return;
    switch (raw.type) {
      case 'message_start': {
        const id = raw.message?.id ?? `m_${this.emittedTools.size}_${this.blockKind.size}`;
        this.currentAssistantId = id;
        this.blockKind.clear();
        this.toolBuffers.clear();
        this.emit({ kind: 'assistantStart', id });
        break;
      }
      case 'content_block_start': {
        const idx = raw.index ?? 0;
        const block: ContentBlock = raw.content_block;
        this.blockKind.set(idx, block?.type ?? 'text');
        if (block?.type === 'tool_use') {
          const b = block as ToolUseBlock;
          this.toolBuffers.set(idx, { id: b.id, name: b.name, json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = raw.index ?? 0;
        const delta = raw.delta ?? {};
        const id = this.currentAssistantId ?? 'm';
        if (delta.type === 'text_delta') {
          this.streamedText.add(id);
          this.emit({ kind: 'assistantText', id, delta: delta.text ?? '' });
        } else if (delta.type === 'thinking_delta') {
          this.emit({ kind: 'thinking', id, delta: delta.thinking ?? '' });
        } else if (delta.type === 'input_json_delta') {
          const buf = this.toolBuffers.get(idx);
          if (buf) buf.json += delta.partial_json ?? '';
        }
        break;
      }
      case 'content_block_stop': {
        const idx = raw.index ?? 0;
        const buf = this.toolBuffers.get(idx);
        if (buf && !this.emittedTools.has(buf.id)) {
          this.emittedTools.add(buf.id);
          const input = safeJson(buf.json);
          this.emit({ kind: 'toolUse', id: buf.id, name: buf.name, input });
          this.hooks.onToolUse?.(buf.name, input);
        }
        break;
      }
      case 'message_stop': {
        if (this.currentAssistantId) this.emit({ kind: 'assistantDone', id: this.currentAssistantId });
        break;
      }
    }
  }

  private onAssistant(ev: AssistantEvent): void {
    const id = ev.message?.id ?? this.currentAssistantId ?? `m_${this.emittedTools.size}`;
    const blocks = ev.message?.content ?? [];
    if (!this.streamedText.has(id)) {
      const text = blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => (b as any).type === 'text')
        .map((b: any) => b.text)
        .join('');
      if (text) {
        this.emit({ kind: 'assistantStart', id });
        this.emit({ kind: 'assistantText', id, delta: text });
        this.emit({ kind: 'assistantDone', id });
      }
    }
    for (const b of blocks) {
      if ((b as any).type === 'tool_use') {
        const t = b as ToolUseBlock;
        if (!this.emittedTools.has(t.id)) {
          this.emittedTools.add(t.id);
          this.emit({ kind: 'toolUse', id: t.id, name: t.name, input: t.input });
          this.hooks.onToolUse?.(t.name, t.input);
          if (isBackgroundLaunch(t.name, t.input)) {
            this.addBgTask(t.id, t.name, backgroundLabel(t.name, t.input));
          }
        }
      }
    }
  }

  private onUser(ev: UserEvent): void {
    const content = ev.message?.content;

    // Notificação de conclusão de tarefa em background (injetada pela própria CLI):
    // `<task-notification>...<tool-use-id>ID</tool-use-id>...`. Tira a tarefa do
    // conjunto e marca busy=true: a CLI inicia um turno por conta própria respondendo
    // à notificação, então o `result` seguinte precisa ser contabilizado (sem isto
    // ele cairia no descarte "stray/replay" porque busy estava false).
    //
    // A notificação chega ora como `content` string, ora como bloco `text` dentro
    // de um array, ora dentro do `content` de um `tool_result` — varremos TODAS as
    // formas para não deixar tarefa pendurada (uma notificação pode fechar várias).
    const notifText = collectUserText(content);
    if (notifText.includes('<task-notification>')) {
      const re = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>/g;
      let m: RegExpExecArray | null;
      let cleared = false;
      while ((m = re.exec(notifText))) {
        this.clearBgTask(m[1].trim());
        cleared = true;
      }
      if (cleared && !this.busy) {
        this.setBusy(true);
        this.stats.beginTurn();
      }
    }

    if (Array.isArray(content)) {
      for (const b of content) {
        if ((b as any).type === 'tool_result') {
          const r = b as ToolResultBlock;
          this.emit({ kind: 'toolResult', toolUseId: r.tool_use_id, content: r.content, isError: r.is_error });
        }
      }
    }
  }

  private resetStreamingState(): void {
    this.currentAssistantId = undefined;
    this.streamedText.clear();
    this.blockKind.clear();
    this.toolBuffers.clear();
    this.emittedTools.clear();
  }
}

// Detecta o lançamento de uma tarefa em background: o tool `Workflow` (sempre
// roda em background) ou qualquer tool com `run_in_background: true` (Bash, Task).
function isBackgroundLaunch(name: string, input: unknown): boolean {
  if (name === 'Workflow') return true;
  const o = (input ?? {}) as Record<string, unknown>;
  return o.run_in_background === true;
}

// Rótulo do que a tarefa em background está fazendo (mostrado ao usuário).
// Best-effort e tolerante: nome do workflow > descrição > 1ª linha do comando > tool.
function backgroundLabel(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const desc = typeof o.description === 'string' ? o.description.trim() : '';
  if (name === 'Workflow') {
    // O nome do workflow mora no `meta = { name: '...' }` do script inline OU é
    // passado por `name` (workflow salvo). Extrai o 1º que casar.
    if (typeof o.name === 'string' && o.name.trim()) return o.name.trim();
    const script = typeof o.script === 'string' ? o.script : '';
    const m = /name\s*:\s*['"]([^'"]+)['"]/.exec(script);
    if (m) return m[1];
    return desc || 'Workflow';
  }
  if (desc) return desc;
  if (typeof o.command === 'string') return o.command.split('\n')[0].slice(0, 80);
  return name;
}

// Concatena todo o texto de um `content` de mensagem `user`, seja ele string,
// array de blocos `text`, ou `tool_result` cujo `content` também é string/array.
// Usado só para varrer `<task-notification>` — tolerante a shape.
function collectUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    const o = b as any;
    if (o?.type === 'text' && typeof o.text === 'string') parts.push(o.text);
    else if (o?.type === 'tool_result') parts.push(collectUserText(o.content));
  }
  return parts.join('\n');
}

function safeJson(s: string): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

// Extrai nomes de slash commands do payload do handshake `initialize` (shape
// tolerante: chaves variam entre versões do CLI). Strip de "/" à frente.
function extractSlashCommands(o: any): string[] {
  if (!o || typeof o !== 'object') return [];
  const arr = o.commands ?? o.slash_commands ?? o.slashCommands ?? o.available_commands;
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  for (const it of arr) {
    const name =
      typeof it === 'string' ? it : it && typeof it.name === 'string' ? it.name : undefined;
    if (name) out.push(name.replace(/^\//, ''));
  }
  return out;
}

// Erro transitório (queda de conexão / stall / retry / timeout de stream) — NÃO
// fatal: o CLI moderno preserva a resposta parcial e re-tenta. Distinguir de erro
// real evita surfaçar ruído assustador e disparar fluxo de auth indevido.
function isTransientError(text: unknown, subtype?: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  const st = typeof subtype === 'string' ? subtype : '';
  return (
    /error_during_execution|stream (disconnect|stall|error)|connection (drop|reset|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|premature close|waiting for api response|will retry|overloaded|\b5\d{2}\b/i.test(
      s,
    ) || /error_during_execution|max_turns/i.test(st)
  );
}

// Heurística conservadora p/ erro de autenticação do CLI (headless não loga).
function isAuthError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  return /please run \/login|\/login|not authenticated|authentication (failed|required|error)|invalid api key|unauthorized|\b401\b|oauth|please (log ?in|sign ?in)/i.test(
    s,
  );
}
