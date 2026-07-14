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
  settings: () => { model: string; effort: string; permission: string; allowAgents: boolean };
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
  // Último inventário do `system/init` (tools + servidores MCP). Fonte do painel MCP:
  // diz quais tools cada servidor expõe — algo que o `claude mcp list` não informa.
  lastTools?: string[];
  lastMcpServers?: { name: string; status: string }[];

  // Tarefas em background ainda rodando (Workflow / tool com run_in_background).
  // O turno que as lança termina (`result` zera o busy), mas o trabalho continua;
  // mantemos o indicador de "executando" vivo enquanto este mapa não esvaziar.
  // Chave = `task_id` do engine; valor = {tool, label} mostrado ao usuário.
  //
  // A fonte da verdade são os eventos `system` do stream (`background_tasks_changed`,
  // `task_started`, `task_updated`, `task_notification`). NÃO dá para deduzir do texto
  // `<task-notification>`: quando a tarefa termina com um turno em voo, a CLI enfileira
  // a notificação e ela nunca chega ao stdout como mensagem — só o evento `system` chega.
  private bgTasks = new Map<string, { tool: string; label: string }>();

  // tool_use id → nome da tool, para dar nome à tarefa quando o `task_started` chega
  // (o evento traz o tool_use id, não o nome). Só guarda o que ainda pode virar tarefa.
  private toolNames = new Map<string, string>();

  // Overrides POR ABA (em memória). Vazio = usa o default das settings.
  modelOverride?: string;
  effortOverride?: string;
  permissionOverride?: string;
  // Liberar agentes (Task) e workflows (Workflow). undefined = usa o default das settings.
  allowAgentsOverride?: boolean;

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

  /** Insere ou refina (o `task_started` chega depois e sabe a tool de verdade). */
  private addBgTask(id: string, tool: string, label: string): void {
    const cur = this.bgTasks.get(id);
    if (cur && cur.tool === tool && cur.label === label) return;
    this.bgTasks.set(id, { tool, label });
    this.emitBackground();
  }

  private clearBgTask(id: string): void {
    if (!this.bgTasks.delete(id)) return;
    this.emitBackground();
  }

  /**
   * `background_tasks_changed` traz a lista COMPLETA do que roda agora — é a fonte da
   * verdade. Reconcilia contra ela: some o que morreu (inclusive tarefas mortas pelo
   * agente, que não emitem notificação) e aparece o que a UI não viu nascer (ex.: sessão
   * retomada com tarefa já em andamento).
   */
  private syncBgTasks(tasks: any[]): void {
    const live = new Map<string, any>();
    for (const t of tasks) if (t?.task_id != null) live.set(String(t.task_id), t);
    let changed = false;
    for (const id of [...this.bgTasks.keys()]) {
      if (!live.has(id)) {
        this.bgTasks.delete(id);
        changed = true;
      }
    }
    for (const [id, t] of live) {
      if (this.bgTasks.has(id)) continue;
      this.bgTasks.set(id, { tool: taskTool(t.task_type), label: String(t.description ?? id) });
      changed = true;
    }
    if (changed) this.emitBackground();
  }

  /** Zera o estado de background (parada/limpeza da sessão). */
  private resetBgTasks(): void {
    this.toolNames.clear();
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
        if (s.subtype === 'background_tasks_changed') {
          this.syncBgTasks(Array.isArray(s.tasks) ? s.tasks : []);
          break;
        }
        if (s.subtype === 'task_started') {
          const tool = this.toolNames.get(s.tool_use_id) ?? taskTool(s.task_type);
          this.toolNames.delete(s.tool_use_id);
          this.addBgTask(String(s.task_id), tool, String(s.description ?? s.task_id));
          break;
        }
        if (s.subtype === 'task_notification' || s.subtype === 'task_updated') {
          // Qualquer estado que não seja `running` = a tarefa saiu do ar (concluída,
          // falhou, morta pelo agente). `background_tasks_changed` também cobre isto,
          // mas fechar aqui evita depender da ordem entre os dois eventos.
          const status = String(s.status ?? s.patch?.status ?? '');
          if (status && status !== 'running') this.clearBgTask(String(s.task_id));
          // Tarefa concluída com a sessão ociosa: a CLI abre um turno por conta própria
          // para reagir à notificação. Sem marcar busy, o `result` desse turno cairia no
          // descarte "stray/replay" e não seria contabilizado. Tarefa morta (`stopped`/
          // `killed`) não gera turno — marcar busy aí deixaria o spinner preso.
          if (s.subtype === 'task_notification' && !this.busy && (status === 'completed' || status === 'failed')) {
            this.setBusy(true);
            this.stats.beginTurn();
          }
          break;
        }
        if (s.subtype === 'init') {
          if (Array.isArray(s.slash_commands)) this.slashCommands = s.slash_commands;
          // Guarda o inventário do init: o painel MCP precisa dele a qualquer momento,
          // não só no instante em que o evento passa.
          this.lastTools = Array.isArray(s.tools) ? s.tools : undefined;
          this.lastMcpServers = Array.isArray(s.mcp_servers) ? s.mcp_servers : undefined;
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
          // Lançamento em background (Workflow, ou tool com run_in_background): guarda o
          // nome para nomear a tarefa quando o `task_started` correspondente chegar.
          if (t.name === 'Workflow' || (t.input as any)?.run_in_background === true) {
            this.toolNames.set(t.id, t.name);
          }
        }
      }
    }
  }

  private onUser(ev: UserEvent): void {
    const content = ev.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if ((b as any).type === 'tool_result') {
        const r = b as ToolResultBlock;
        this.emit({ kind: 'toolResult', toolUseId: r.tool_use_id, content: r.content, isError: r.is_error });
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

// Rótulo da tool a partir do `task_type` do engine. Usado só quando a tarefa aparece
// sem que tenhamos visto o `tool_use` que a lançou (sessão retomada, subagente).
function taskTool(taskType: unknown): string {
  switch (taskType) {
    case 'local_bash':
      return 'Bash';
    case 'workflow':
      return 'Workflow';
    default:
      return typeof taskType === 'string' && taskType ? taskType : 'Task';
  }
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
