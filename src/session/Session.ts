// Um runtime de conversa: encapsula um processo do CLI, suas estatísticas e
// todo o estado de streaming. Emite mensagens de UI por um callback (o provider
// as etiqueta com o id da aba e encaminha ao webview). Várias instâncias rodam
// em paralelo — uma por aba.
import { CliProcessManager } from '../cli/CliProcessManager';
import { StatsAggregator } from '../stats/StatsAggregator';
import { log } from '../util/logger';
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
  fileText: (tool: string, input: unknown) => string | undefined;
  claudePath: () => string;
  cwd: () => string;
  // Defaults vindos das settings (o que 'default' resolve quando não há override).
  settings: () => { model: string; effort: string; permission: string };
}

export class Session {
  cli?: CliProcessManager;
  stats: StatsAggregator;
  resumeId?: string;
  busy = false;
  slashCommands: string[] = [];
  sessionId?: string;

  // Overrides POR ABA (em memória). Vazio = usa o default das settings.
  modelOverride?: string;
  effortOverride?: string;
  permissionOverride?: string;

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
    return this.modelOverride ?? this.hooks.settings().model;
  }
  effort(): string {
    return this.effortOverride ?? this.hooks.settings().effort;
  }
  permission(): string {
    return this.permissionOverride ?? this.hooks.settings().permission;
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
      resumeSessionId: this.resumeId,
    });
    this.cli.on('event', (e: ClaudeEvent) => this.onCliEvent(e));
    this.cli.on('stderr', (t: string) => {
      log(`[cli stderr] ${t.trim()}`);
      if (isAuthError(t)) this.hooks.onAuthRequired();
    });
    this.cli.on('exit', (code) => {
      log(`CLI exited (${code})`);
      this.setBusy(false);
    });
    this.cli.start();
  }

  send(text: string, images?: { mediaType: string; data: string }[]): void {
    this.ensureCli();
    this.setBusy(true);
    this.cli!.sendUserMessage(text, images);
  }

  interrupt(): void {
    this.cli?.interrupt();
    this.setBusy(false);
  }

  /** Encerra o processo; mantém as estatísticas. A próxima mensagem respawna. */
  stop(): void {
    this.resetStreamingState();
    this.pendingPerm.clear();
    this.cli?.stop();
    this.cli = undefined;
    this.setBusy(false);
  }

  /** Limpa a conversa por completo (novo/retomar): zera estatísticas também. */
  clearConversation(): void {
    this.stop();
    this.sessionId = undefined;
    this.stats = new StatsAggregator(0);
  }

  resume(sessionId: string): void {
    this.clearConversation();
    this.resumeId = sessionId;
  }

  applyLimits(limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow }, source: 'real' | 'estimate'): void {
    this.stats.setLimits(limits, source);
  }

  snapshot() {
    return this.stats.snapshot();
  }

  // ---- protocolo de controle (permissão / AskUserQuestion) ----

  decide(requestId: string, decision: 'allow' | 'deny' | 'allow_always'): void {
    const pend = this.pendingPerm.get(requestId);
    this.pendingPerm.delete(requestId);
    if (pend?.tool) {
      this.stats.recordDecision(pend.tool, decision);
      this.emit({ kind: 'stats', stats: this.stats.snapshot() });
    }
    if (decision === 'deny') {
      this.cli?.sendControlResponse(requestId, { behavior: 'deny', message: 'Denied by user' });
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
          if (s.session_id) this.cli?.setResumeId(s.session_id); // respawn silencioso continua ESTA sessão

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
        if (r.is_error && isAuthError(r.result ?? r.error ?? '')) this.hooks.onAuthRequired();
        this.emit({ kind: 'turnComplete', costUsd: r.total_cost_usd, usage: r.usage });
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
          this.emit({ kind: 'toolUse', id: buf.id, name: buf.name, input: safeJson(buf.json) });
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
        }
      }
    }
  }

  private onUser(ev: UserEvent): void {
    const content = ev.message?.content;
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

// Heurística conservadora p/ erro de autenticação do CLI (headless não loga).
function isAuthError(text: unknown): boolean {
  const s = typeof text === 'string' ? text : '';
  return /please run \/login|\/login|not authenticated|authentication (failed|required|error)|invalid api key|unauthorized|\b401\b|oauth|please (log ?in|sign ?in)/i.test(
    s,
  );
}
