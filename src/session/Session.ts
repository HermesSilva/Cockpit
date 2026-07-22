// A conversation runtime: it wraps a CLI process, its statistics and
// all the streaming state. It emits UI messages through a callback (the provider
// tags them with the tab id and forwards them to the webview). Several instances run
// in parallel — one per tab.
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
  // The turn ended abnormally: the host locates it and shows the warning in the tab.
  //  - 'aborted': the CLI process died mid-turn (no result).
  //  - 'error':   the CLI reported an error result (the CLI's own text).
  //  - 'transient': drop/stall (the CLI retries); soft warning.
  onTurnError?: (info: { kind: 'aborted' | 'error' | 'transient'; code?: number | null; text?: string }) => void;
  fileText: (tool: string, input: unknown) => string | undefined;
  // Each tool_use (before execution): enables autosaving read/write files.
  onToolUse?: (tool: string, input: unknown) => void;
  claudePath: () => string;
  cwd: () => string;
  // Defaults coming from the settings (what 'default' resolves to when there is no override).
  settings: () => { model: string; effort: string; permission: string; allowAgents: boolean };
  // Language (short code: pt, en…) for the agent's questions (AskUserQuestion).
  askLanguage: () => string;
}

export class Session {
  cli?: CliProcessManager;
  stats: StatsAggregator;
  resumeId?: string;
  busy = false;
  slashCommands: string[] = [];
  sessionId?: string;
  // Latest `system/init` inventory (tools + MCP servers). The MCP panel's source:
  // it says which tools each server exposes — something `claude mcp list` doesn't report.
  lastTools?: string[];
  lastMcpServers?: { name: string; status: string }[];

  // Background tasks still running (Workflow / tool with run_in_background).
  // The turn that launches them ends (`result` clears busy), but the work goes on;
  // we keep the "running" indicator alive while this map isn't empty.
  // Key = the engine's `task_id`; value = {tool, label} shown to the user.
  //
  // The source of truth is the stream's `system` events (`background_tasks_changed`,
  // `task_started`, `task_updated`, `task_notification`). It can NOT be deduced from the
  // `<task-notification>` text: when a task finishes with a turn in flight, the CLI queues
  // the notification and it never reaches stdout as a message — only the `system` event arrives.
  private bgTasks = new Map<string, { tool: string; label: string }>();

  // tool_use id → tool name, to name the task when `task_started` arrives
  // (the event brings the tool_use id, not the name). It only keeps what can still become a task.
  private toolNames = new Map<string, string>();

  // PER-TAB overrides (in memory). Empty = uses the settings default.
  modelOverride?: string;
  effortOverride?: string;
  permissionOverride?: string;
  // Allow agents (Task) and workflows (Workflow). undefined = uses the settings default.
  allowAgentsOverride?: boolean;

  // Streaming state
  private currentAssistantId?: string;
  private streamedText = new Set<string>();
  private blockKind = new Map<number, string>();
  private toolBuffers = new Map<number, { id: string; name: string; json: string }>();
  private emittedTools = new Set<string>();
  private pendingPerm = new Map<string, { tool: string; input: unknown; suggestions?: unknown[] }>();

  constructor(private hooks: SessionHooks) {
    this.stats = new StatsAggregator(0);
  }

  // ---- lifecycle ----

  // Effective values (tab override ?? settings default).
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
      // Blocks subagents/workflows when off (token saving).
      disallowedTools: this.allowAgents() ? undefined : ['Task', 'Workflow'],
      // resumeId ?? sessionId: a defense against any path that knows the
      // sessionId but hasn't pinned the resumeId — avoids a spawn without --resume
      // (which would duplicate the context). clearConversation() clears both for a new conversation.
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
      // Death mid-turn (busy still on = it wasn't stop()/interrupt(),
      // which clear busy first): the process aborted without emitting `result`. Without a warning the
      // indicator disappears and the user thinks it is still running. Finish and warn.
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
    this.stats.beginTurn(); // stopwatch of the active execution time (excludes idleness)
    // State BEFORE the turn: mainly the cache (age/life), to understand what
    // each prompt finds (warm vs. cold cache = re-paying the cacheWrite).
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

  /** Stops the process; keeps the statistics. The next message respawns it. */
  stop(): void {
    this.resetStreamingState();
    this.pendingPerm.clear();
    this.stats.endTurn(); // closes the turn in flight (idle time after it isn't counted)
    this.persist();
    if (this.cli) dlog('session', `stop (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli?.stop();
    this.cli = undefined;
    this.setBusy(false);
    this.resetBgTasks();
  }

  /** Clears the conversation entirely (new/resume): also resets the statistics. */
  clearConversation(): void {
    this.stop();
    this.sessionId = undefined;
    // Also clears the resumeId: a REALLY new conversation. Without this, after "clear
    // context" on a resumed session the next send() would respawn with --resume of the
    // old session (it wouldn't clear) — and the init pinning would keep that id glued on.
    this.resumeId = undefined;
    this.stats = new StatsAggregator(0);
  }

  resume(sessionId: string): void {
    this.clearConversation();
    this.resumeId = sessionId;
    // Hydrates the persisted accumulators: the session KEEPS being coherent (the CLI doesn't
    // re-emit the usage of old turns on --resume).
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

  /** Persists this session's statistics (debounced/atomic). Requires a sessionId. */
  private persist(): void {
    const id = this.sessionId ?? this.resumeId;
    if (id) saveStats(this.stats.serialize(id, this.hooks.cwd()));
  }

  /**
   * Keep-alive ping through this session's LIVE CLI (not through a parallel --resume, which
   * would conflict with the open process). It reuses the normal turn flow: the
   * `result` stops the stopwatch and persists lastTurnTs → restarting the cache life.
   * Returns false when busy (a turn in progress already keeps the cache warm).
   */
  keepAlivePing(): boolean {
    if (this.busy) return false;
    this.ensureCli();
    this.setBusy(true);
    this.stats.beginTurn();
    dlog('session', `keep-alive ping (${this.sessionId ?? this.resumeId ?? '?'})`);
    this.cli!.sendUserMessage('keep-alive: answer only "ok". Do not use tools and do not change files.');
    return true;
  }

  /** Turns this context's cache keep-alive on/off and persists the state. */
  setKeepCacheAlive(value: boolean): void {
    this.stats.setKeepCacheAlive(value);
    this.persist();
    this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    dlog('session', `keepCacheAlive=${value} (${this.sessionId ?? this.resumeId ?? '?'})`);
  }

  /** Sends the timeline/compactions (heavy) — per turn, not per token. */
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

  /** Re-sends this session's timeline/compactions (when switching/opening the tab). */
  sendTimeline(): void {
    this.emitTimeline();
  }

  // ---- control protocol (permission / AskUserQuestion) ----

  decide(requestId: string, decision: 'allow' | 'deny' | 'allow_always', message?: string): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    if (pend?.tool) {
      // On denials, records the reason (the user's feedback) in the denial log.
      this.stats.recordDecision(pend.tool, decision, decision === 'deny' ? message : undefined);
      this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    }
    if (decision === 'deny') {
      // `message` = the user's feedback (e.g. notes in editable plan mode).
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

  // ---- internals ----

  private setBusy(b: boolean): void {
    this.busy = b;
    this.hooks.onBusy(b);
  }

  /** Inserts or refines it (`task_started` arrives later and knows the real tool). */
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
   * `background_tasks_changed` brings the COMPLETE list of what is running now — it is the source of
   * truth. Reconcile against it: whatever died disappears (including tasks killed by the
   * agent, which emit no notification) and whatever the UI didn't see being born appears (e.g. a session
   * resumed with a task already in progress).
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

  /** Clears the background state (session stop/cleanup). */
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
          // Any state other than `running` = the task is gone (finished,
          // failed, killed by the agent). `background_tasks_changed` covers this too,
          // but closing here avoids depending on the order between the two events.
          const status = String(s.status ?? s.patch?.status ?? '');
          if (status && status !== 'running') this.clearBgTask(String(s.task_id));
          // Task finished with the session idle: the CLI opens a turn on its own
          // to react to the notification. Without marking busy, that turn's `result` would fall into
          // the "stray/replay" discard and wouldn't be counted. A killed task (`stopped`/
          // `killed`) generates no turn — marking busy there would leave the spinner stuck.
          if (s.subtype === 'task_notification' && !this.busy && (status === 'completed' || status === 'failed')) {
            this.setBusy(true);
            this.stats.beginTurn();
          }
          break;
        }
        if (s.subtype === 'init') {
          if (Array.isArray(s.slash_commands)) this.slashCommands = s.slash_commands;
          // Stores the init inventory: the MCP panel needs it at any moment,
          // not only at the instant the event goes by.
          this.lastTools = Array.isArray(s.tools) ? s.tools : undefined;
          this.lastMcpServers = Array.isArray(s.mcp_servers) ? s.mcp_servers : undefined;
          this.sessionId = s.session_id;
          if (s.session_id) {
            this.cli?.setResumeId(s.session_id); // a silent respawn continues THIS session
            // Pins the resume id at SESSION LEVEL: a stop() (model/effort/permission
            // change) discards the CliProcessManager, and the next
            // send() respawns via ensureCli() reading `this.resumeId`. Without this, that
            // respawn would start WITHOUT --resume and the CLI would create a NEW .jsonl — a
            // DUPLICATED context in the Hub. With it, it always continues the same session.
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
        // Response to the `initialize` handshake: it already brings the slash commands BEFORE the
        // first send. (The `system init` only arrives after the first message.)
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
        // Only counts what WE started: send()/keepAlivePing() set busy=true. A
        // `result` with busy=false is stray/replay (e.g. the CLI re-emits turns on
        // `--resume`) — processing it would inflate local turns/cost and pollute the UI.
        if (!this.busy) {
          dlog('session', `result ignored (busy=false): CLI stray/replay`);
          break;
        }
        const errText = String(r.result ?? r.error ?? '').trim();
        if (r.is_error && isAuthError(errText)) {
          this.hooks.onAuthRequired();
        } else if (r.is_error) {
          // Error reported by the CLI at the end of the turn. A transient one (drop/stall, CLI
          // 2.1.179+ preserves the partial) gets a soft warning; the rest get an error warning
          // with the CLI's own text. Without this the turn "dies" with no explanation.
          const transient = isTransientError(errText, r.subtype);
          log(`[session] result ${transient ? 'transient' : 'error'} (${this.sessionId ?? '?'}): ${errText.slice(0, 160)}`);
          this.hooks.onTurnError?.({ kind: transient ? 'transient' : 'error', text: errText || undefined });
        }
        this.stats.endTurn(); // stops the prompt's stopwatch (real execution time)
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
        this.persist(); // saves the session state (stays coherent on reopen)
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
   * Account limit coming from the engine in the stream. Automatic channel (no statusline):
   * status + reset + window always; % (`utilization`) only close to the limit.
   */
  private onRateLimit(info: any): void {
    if (!info || typeof info !== 'object') return;
    const type = info.rateLimitType ?? info.rate_limit_type;
    const which = type === 'five_hour' ? 'fiveHour' : type === 'seven_day' ? 'sevenDay' : undefined;
    if (!which) return; // seven_day_opus/sonnet/overage: outside the 2 displayed windows
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
        /* invalid epoch */
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
          // Background launch (Workflow, or a tool with run_in_background): stores the
          // name so the task can be named when the matching `task_started` arrives.
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

// Tool label from the engine's `task_type`. Used only when the task shows up
// without us having seen the `tool_use` that launched it (resumed session, subagent).
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

// Extracts slash command names from the `initialize` handshake payload (tolerant
// shape: the keys vary between CLI versions). Leading "/" is stripped.
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

// Transient error (connection drop / stall / retry / stream timeout) — NOT
// fatal: the modern CLI preserves the partial response and retries. Telling it apart from a
// real error avoids surfacing scary noise and triggering an undue auth flow.
function isTransientError(text: unknown, subtype?: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  const st = typeof subtype === 'string' ? subtype : '';
  return (
    /error_during_execution|stream (disconnect|stall|error)|connection (drop|reset|closed|error)|ECONNRESET|ETIMEDOUT|socket hang up|premature close|waiting for api response|will retry|overloaded|\b5\d{2}\b/i.test(
      s,
    ) || /error_during_execution|max_turns/i.test(st)
  );
}

// Conservative heuristic for a CLI authentication error (headless doesn't sign in).
function isAuthError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  return /please run \/login|\/login|not authenticated|authentication (failed|required|error)|invalid api key|unauthorized|\b401\b|oauth|please (log ?in|sign ?in)/i.test(
    s,
  );
}
