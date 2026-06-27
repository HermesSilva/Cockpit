// Agrega usage dos eventos em um StatsSnapshot para a UI.
// Cobre contexto, cache, custo e (quando disponível) limites da conta.
import type { ClaudeEvent, Usage } from '../../shared/events';
import type {
  StatsSnapshot,
  LimitWindow,
  ToolDecision,
  ModelUsage,
  TimelineSample,
  CompactionEvent,
  DenialEvent,
} from '../../shared/protocol';
import { STATS_VERSION, capTimeline, type PersistedStats } from './StatsStore';
import { dlog } from '../util/logger';

// Vida do prompt cache (TTL estendido de 1h do Claude Code): após este tempo
// ocioso o prefixo cacheado expira e o turno seguinte re-escreve tudo (reset
// frio). Cada requisição que acerta o prefixo REINICIA esta janela — é a base do
// keep-alive (reenvio antes de completar 1h). Exportado p/ o CacheKeeper.
export const CACHE_LIFE_MS = 60 * 60_000;
// Turno é reset por TTL se: não é o 1º, ficou ocioso > vida do cache, leu quase
// nada do cache e re-escreveu prefixo. Conservador p/ não contar falso-positivo.
const COLD_READ_FRAC = 0.1;
// Compactação: o contexto TOTAL encolheu abaixo desta fração do turno anterior.
// (Reset frio NÃO encolhe o total — só desloca read→create — então não colide.)
const COMPACT_FRAC = 0.6;
// Negações guardadas no log (E5): as últimas N, o suficiente p/ auditar a sessão.
const DENIAL_CAP = 50;

// Preços por 1M tokens (USD). Estimativa — rotulada como tal na Ui.
interface Price {
  input: number;
  output: number;
  cacheWrite: number; // ~1.25x input
  cacheRead: number; // ~0.1x input
}
const PRICES: { match: RegExp; price: Price }[] = [
  { match: /opus/i, price: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } },
  { match: /sonnet/i, price: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 } },
  { match: /haiku/i, price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 } },
  { match: /fable|mythos/i, price: { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 } },
];
const DEFAULT_PRICE: Price = { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 };

function priceFor(model?: string): Price {
  if (!model) return DEFAULT_PRICE;
  return PRICES.find((p) => p.match.test(model))?.price ?? DEFAULT_PRICE;
}

/** Custo estimado (USD) de um bloco de usage, pela tabela de preço do modelo. */
export function estimateCost(u: Usage, model?: string): number {
  const p = priceFor(model);
  const inp = u.input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  return (inp * p.input + cw * p.cacheWrite + cr * p.cacheRead + out * p.output) / 1_000_000;
}

/** Limite efetivo do Claude Code: variante [1m] = 1M; caso contrário 200K. */
export function deriveContextLimit(model?: string): number {
  if (model && /\[1m\]/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Normaliza o id do modelo: colapsa sufixos [1m] repetidos. O CLID já normaliza
 * (2.1.172/173: `[1M][1m]` virava duplicado), mas eventos antigos retomados podem
 * trazer o id duplicado — defensivo p/ não inflar o display nem confundir o preço.
 */
export function normalizeModel(model?: string): string | undefined {
  if (!model) return model;
  return model.replace(/(\[1m\])(\[1m\])+/gi, '$1');
}

/** Coerção defensiva p/ token count vindo do stream: número finito ≥ 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export class StatsAggregator {
  private model?: string;
  private mode?: string;
  private contextLimit: number;
  private autoLimit: boolean;
  private contextUsed = 0;

  private inputTokens = 0;
  private outputTokens = 0;
  private cacheCreateTokens = 0;
  private cacheReadTokens = 0;
  // Turno em voo (parcial via message_start): refletido no display até o evento
  // assistant consolidar nos totais. Evita o painel mostrar 0 durante o 1º turno
  // (frio/lento), quando o contexto já encheu mas os totais ainda não acumularam.
  private curInput = 0;
  private curOutput = 0;
  private curCreate = 0;
  private curRead = 0;

  private sessionCostUsd = 0;
  private lastTurnCostUsd = 0;
  private lastTurnHitRate = 0; // cr/total do último turno consolidado
  private costIsEstimate = true;

  private sessionStartTs?: number;
  private toolDecisions = new Map<string, { allow: number; allowAlways: number; deny: number }>();
  // Log das negações (E5): últimas DENIAL_CAP, mais recentes no fim.
  private denials: DenialEvent[] = [];

  // --- Contadores que sobrevivem ao reopen do contexto ---
  private turnCount = 0;
  private reopenCount = 0;
  private cacheResetCount = 0;
  private cacheRecacheCostUsd = 0;
  private compactionCount = 0;
  private peakContextUsed = 0;
  private peakContextTs?: number;
  // Tempo de execução REAL: soma do tempo de cada prompt (send → result/stop).
  // NÃO inclui ociosidade (agente parado). turnStartTs marca o turno em voo.
  private activeMs = 0;
  private turnStartTs?: number;
  // Keep-alive: se marcado, o CacheKeeper reenvia este contexto antes do cache
  // de 1h expirar (mesmo com a aba/contexto fechado). Estado persistido.
  private keepCacheAlive = false;
  // Estado p/ detecção entre turnos.
  private prevContextUsed = 0;
  private prevCacheRead = 0;
  private lastTurnTs = 0;
  // Detalhamento por modelo e séries históricas.
  private perModel = new Map<string, ModelUsage>();
  private timeline: TimelineSample[] = [];
  private compactions: CompactionEvent[] = [];

  private limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } = {};
  private limitsSource: 'real' | 'estimate' = 'estimate';
  // Canal separado: limites vindos do stream (rate_limit_event). Não é tocado por
  // setLimits (statusline/estimativa periódica), e tem prioridade no merge.
  private streamLimits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } = {};
  private streamSeen = false;

  // configuredLimit > 0 = override manual; 0 = auto (derivado do modelo ativo).
  constructor(configuredLimit: number) {
    if (configuredLimit > 0) {
      this.contextLimit = configuredLimit;
      this.autoLimit = false;
    } else {
      this.contextLimit = deriveContextLimit(undefined);
      this.autoLimit = true;
    }
  }

  // authoritative=true (init / override): define exibição e limite (carrega o [1m]).
  // authoritative=false (eventos por-mensagem): o id da API vem SEM o sufixo [1m];
  // não pode sobrescrever o modelo de sessão nem rebaixar o limite para 200K.
  setModel(model?: string, authoritative = false) {
    const m = normalizeModel(model);
    if (!m) return;
    if (authoritative) {
      this.model = m;
      if (this.autoLimit) this.contextLimit = deriveContextLimit(m);
    } else if (!this.model) {
      this.model = m;
    }
  }
  setMode(mode?: string) {
    if (mode) this.mode = mode;
  }
  setContextLimit(limit: number) {
    if (limit > 0) {
      this.contextLimit = limit;
      this.autoLimit = false;
    }
  }

  /** Limites de conta (real via statusline, ou estimativa local). */
  setLimits(
    limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow },
    source: 'real' | 'estimate' = 'estimate',
  ) {
    this.limits = limits;
    this.limitsSource = source;
  }

  /**
   * Limite de uma janela vindo do stream (rate_limit_event). Mescla por bucket
   * (eventos chegam um bucket por vez), preservando a outra janela.
   */
  setStreamLimit(which: 'fiveHour' | 'sevenDay', win: LimitWindow) {
    this.streamLimits[which] = { ...this.streamLimits[which], ...win };
    this.streamSeen = true;
  }

  /** Registra decisão de permissão do usuário (allow/deny) por ferramenta. Em
   *  negações, guarda também a entrada no log (com a razão, quando houver). */
  recordDecision(tool: string, decision: 'allow' | 'deny' | 'allow_always', reason?: string): void {
    const entry = this.toolDecisions.get(tool) ?? { allow: 0, allowAlways: 0, deny: 0 };
    if (decision === 'allow') entry.allow++;
    else if (decision === 'allow_always') entry.allowAlways++;
    else {
      entry.deny++;
      const clean = typeof reason === 'string' ? reason.trim() : '';
      this.denials.push({ tool, ts: Date.now(), reason: clean || undefined });
      if (this.denials.length > DENIAL_CAP) this.denials = this.denials.slice(-DENIAL_CAP);
    }
    this.toolDecisions.set(tool, entry);
  }

  /** Processa um evento e devolve o snapshot atualizado. */
  ingest(ev: ClaudeEvent): StatsSnapshot {
    switch (ev.type) {
      case 'system':
        this.setModel((ev as any).model, true); // init: autoritativo (traz o [1m])
        if ((ev as any).permissionMode) this.mode = (ev as any).permissionMode;
        if (!this.sessionStartTs && (ev as any).subtype === 'init') {
          this.sessionStartTs = Date.now();
        }
        break;
      case 'stream_event': {
        const raw = (ev as any).event;
        if (raw?.type === 'message_start') {
          this.setModel(raw.message?.model, false); // id da API, sem [1m]
          if (raw.message?.usage) this.applyPromptUsage(raw.message.usage);
        } else if (raw?.type === 'message_delta' && raw.usage) {
          // Saída cumulativa do turno em voo (tempo real, token a token).
          this.applyDeltaUsage(raw.usage);
        }
        break;
      }
      case 'assistant': {
        const usage = (ev as any).message?.usage as Usage | undefined;
        this.setModel((ev as any).message?.model, false); // id da API, sem [1m]
        if (usage) this.applyPromptUsage(usage, true);
        break;
      }
      case 'result': {
        const r = ev as any;
        if (typeof r.total_cost_usd === 'number') {
          // Custo real do turno reportado pelo CLI.
          this.lastTurnCostUsd = Math.max(0, r.total_cost_usd - this.sessionCostUsd);
          this.sessionCostUsd = r.total_cost_usd;
          this.costIsEstimate = false;
        }
        break;
      }
    }
    return this.snapshot();
  }

  /**
   * message_delta: usage com `output_tokens` cumulativo do turno em voo. Atualiza
   * SÓ a saída em tempo real — input/cache são fixados no message_start e NÃO devem
   * ser tocados aqui: o delta traz `input_tokens` incremental (= 0 no meio do
   * stream), o que zeraria o input/contexto exibido e faria o número "piscar".
   * O evento `assistant` final consolida nos totais.
   */
  private applyDeltaUsage(u: Usage) {
    // Guarda defensiva: deltas malformados (NaN/negativo) não devem zerar/poluir
    // o display. output_tokens é cumulativo no turno — só sobe.
    const out = num(u.output_tokens);
    if (out > this.curOutput) this.curOutput = out;
  }

  /** input_tokens + cache_* da requisição = tamanho do prompt (≈ contexto usado). */
  private applyPromptUsage(u: Usage, isFinal = false) {
    const inp = num(u.input_tokens);
    const cw = num(u.cache_creation_input_tokens);
    const cr = num(u.cache_read_input_tokens);
    const out = num(u.output_tokens);

    this.contextUsed = inp + cw + cr;

    if (isFinal) {
      // Consolida o turno nos totais da sessão e zera o turno em voo.
      this.inputTokens += inp;
      this.cacheCreateTokens += cw;
      this.cacheReadTokens += cr;
      this.outputTokens += out;
      this.curInput = this.curCreate = this.curRead = this.curOutput = 0;

      const p = priceFor(this.model);
      const turnCost =
        (inp * p.input + cw * p.cacheWrite + cr * p.cacheRead + out * p.output) / 1_000_000;
      if (this.costIsEstimate) {
        this.lastTurnCostUsd = turnCost;
        this.sessionCostUsd += turnCost;
      }

      this.consolidateTurn(inp, out, cw, cr, turnCost, p);
    } else {
      // message_start (parcial): reflete o turno atual no display de imediato.
      this.curInput = inp;
      this.curCreate = cw;
      this.curRead = cr;
      this.curOutput = out;
    }
  }

  /**
   * Pós-consolidação de um turno: detecta cache reset (TTL frio) e compactação,
   * atualiza contadores, pico, breakdown por modelo e a amostra de timeline.
   */
  private consolidateTurn(inp: number, out: number, cw: number, cr: number, turnCost: number, p: Price): void {
    const now = Date.now();
    const total = inp + cw + cr; // = contextUsed do turno
    const readFrac = total > 0 ? cr / total : 0;
    const gap = this.lastTurnTs > 0 ? now - this.lastTurnTs : 0;

    // Cache reset (TTL frio): turno não-inicial, ocioso > TTL, leu ~0 do cache e
    // re-escreveu o prefixo. Re-paga o cacheWrite — perda contabilizada.
    const isReset = this.turnCount > 0 && gap > CACHE_LIFE_MS && readFrac < COLD_READ_FRAC && cw > 0;
    if (isReset) {
      this.cacheResetCount++;
      const cost = (cw * p.cacheWrite) / 1_000_000;
      this.cacheRecacheCostUsd += cost;
      dlog(
        'stats',
        `cache reset #${this.cacheResetCount} (${this.model ?? '?'}): ocioso ${(gap / 60_000).toFixed(1)}m, readFrac=${readFrac.toFixed(3)}, re-cache ${cw} tok = $${cost.toFixed(4)}`,
      );
    }

    // Compactação: o contexto TOTAL encolheu vs. o turno anterior (e não foi reset).
    let isCompaction = false;
    if (
      this.turnCount > 0 &&
      !isReset &&
      this.prevContextUsed > 0 &&
      total < this.prevContextUsed * COMPACT_FRAC
    ) {
      isCompaction = true;
      this.compactionCount++;
      this.compactions.push({
        ts: now,
        before: this.prevContextUsed,
        after: total,
        saved: this.prevContextUsed - total,
      });
      dlog(
        'stats',
        `compactação #${this.compactionCount}: ${this.prevContextUsed} → ${total} tok (−${this.prevContextUsed - total})`,
      );
    }

    this.turnCount++;
    if (total > this.peakContextUsed) {
      this.peakContextUsed = total;
      this.peakContextTs = now;
    }

    // Acúmulo por modelo (custo por modelo é sempre estimativa de tabela).
    const key = this.model ?? 'unknown';
    const m =
      this.perModel.get(key) ??
      ({
        model: key,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        turns: 0,
      } satisfies ModelUsage);
    m.inputTokens += inp;
    m.outputTokens += out;
    m.cacheCreateTokens += cw;
    m.cacheReadTokens += cr;
    m.costUsd += turnCost;
    m.turns++;
    this.perModel.set(key, m);

    this.timeline.push({
      ts: now,
      contextUsed: total,
      cacheReadPct: readFrac,
      costUsd: this.sessionCostUsd,
      reset: isReset || undefined,
      compaction: isCompaction || undefined,
    });
    this.timeline = capTimeline(this.timeline);

    this.lastTurnHitRate = readFrac;
    this.prevContextUsed = total;
    this.prevCacheRead = cr;
    this.lastTurnTs = now;
  }

  /** Registra uma reabertura/retomada deste contexto (incrementa reopenCount). */
  markReopen(): void {
    this.reopenCount++;
  }

  /** Liga/desliga o keep-alive de cache deste contexto (persistido). */
  setKeepCacheAlive(v: boolean): void {
    this.keepCacheAlive = v;
  }

  /** Início de um prompt (send): arma o cronômetro do tempo de execução ativo. */
  beginTurn(): void {
    if (this.turnStartTs == null) this.turnStartTs = Date.now();
  }

  /** Fim do prompt (result/interrupt/stop): soma o tempo trabalhado, ignora ocioso. */
  endTurn(): void {
    if (this.turnStartTs != null) {
      this.activeMs += Math.max(0, Date.now() - this.turnStartTs);
      this.turnStartTs = undefined;
    }
  }

  /** Tempo do turno em voo (p/ o display somar ao activeMs sem fechar o turno). */
  private liveTurnMs(): number {
    return this.turnStartTs != null ? Math.max(0, Date.now() - this.turnStartTs) : 0;
  }

  /**
   * Vida do cache: idade desde a última requisição (lastTurnTs) e quanto falta
   * p/ expirar a janela de 1h. Indefinido enquanto não houve nenhum turno.
   */
  private cacheLife(): {
    cacheLifeMs: number;
    cacheAgeMs?: number;
    cacheExpiresInMs?: number;
    cacheExpiresAt?: number;
    cacheAlive?: boolean;
  } {
    if (this.lastTurnTs <= 0) return { cacheLifeMs: CACHE_LIFE_MS };
    const age = Math.max(0, Date.now() - this.lastTurnTs);
    return {
      cacheLifeMs: CACHE_LIFE_MS,
      cacheAgeMs: age,
      cacheExpiresInMs: Math.max(0, CACHE_LIFE_MS - age),
      cacheExpiresAt: this.lastTurnTs + CACHE_LIFE_MS, // epoch ms — p/ contagem ao vivo na UI
      cacheAlive: age < CACHE_LIFE_MS,
    };
  }

  /** Timeline + compactações p/ a mensagem `statsTimeline` (enviada por turno). */
  timelineSnapshot(): { timeline: TimelineSample[]; compactions: CompactionEvent[] } {
    return { timeline: this.timeline, compactions: this.compactions };
  }

  /** Restaura os acumuladores de um estado persistido (continuação coerente). */
  hydrate(p: PersistedStats): void {
    this.model = p.model ?? this.model;
    this.mode = p.mode ?? this.mode;
    if (p.contextLimit > 0) {
      this.contextLimit = p.contextLimit;
      this.autoLimit = p.autoLimit;
    }
    this.sessionStartTs = p.sessionStartTs ?? this.sessionStartTs;
    this.inputTokens = p.inputTokens;
    this.outputTokens = p.outputTokens;
    this.cacheCreateTokens = p.cacheCreateTokens;
    this.cacheReadTokens = p.cacheReadTokens;
    this.sessionCostUsd = p.sessionCostUsd;
    this.costIsEstimate = p.costIsEstimate;
    this.turnCount = p.turnCount;
    this.reopenCount = p.reopenCount;
    this.cacheResetCount = p.cacheResetCount;
    this.cacheRecacheCostUsd = p.cacheRecacheCostUsd;
    this.compactionCount = p.compactionCount;
    this.peakContextUsed = p.peakContextUsed;
    this.peakContextTs = p.peakContextTs;
    this.activeMs = p.activeMs ?? 0;
    this.keepCacheAlive = p.keepCacheAlive ?? false;
    this.prevContextUsed = p.lastContextUsed;
    this.contextUsed = p.lastContextUsed; // restaura a barra de contexto de imediato
    this.prevCacheRead = p.lastCacheRead;
    // Hit do último turno reconstruído do par persistido (cr/total).
    this.lastTurnHitRate = p.lastContextUsed > 0 ? p.lastCacheRead / p.lastContextUsed : 0;
    this.lastTurnTs = p.lastTurnTs;
    this.perModel = new Map(Object.entries(p.perModel ?? {}));
    this.toolDecisions = new Map(Object.entries(p.toolDecisions ?? {}));
    this.denials = Array.isArray(p.denials) ? p.denials.slice(-DENIAL_CAP) : [];
    this.timeline = Array.isArray(p.timeline) ? p.timeline : [];
    this.compactions = Array.isArray(p.compactions) ? p.compactions : [];
  }

  /** Serializa o estado para persistir por sessão. `cwd` permite ao CacheKeeper
   *  retomar o contexto (claude --resume na pasta certa) com a aba fechada. */
  serialize(sessionId: string, cwd?: string): PersistedStats {
    return {
      version: STATS_VERSION,
      sessionId,
      cwd,
      keepCacheAlive: this.keepCacheAlive,
      model: this.model,
      mode: this.mode,
      contextLimit: this.contextLimit,
      autoLimit: this.autoLimit,
      sessionStartTs: this.sessionStartTs,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheCreateTokens: this.cacheCreateTokens,
      cacheReadTokens: this.cacheReadTokens,
      sessionCostUsd: this.sessionCostUsd,
      costIsEstimate: this.costIsEstimate,
      turnCount: this.turnCount,
      cacheResetCount: this.cacheResetCount,
      cacheRecacheCostUsd: this.cacheRecacheCostUsd,
      compactionCount: this.compactionCount,
      reopenCount: this.reopenCount,
      peakContextUsed: this.peakContextUsed,
      peakContextTs: this.peakContextTs,
      activeMs: this.activeMs + this.liveTurnMs(),
      lastContextUsed: this.prevContextUsed,
      lastCacheRead: this.prevCacheRead,
      lastTurnTs: this.lastTurnTs,
      perModel: Object.fromEntries(this.perModel),
      toolDecisions: Object.fromEntries(this.toolDecisions),
      denials: this.denials,
      timeline: this.timeline,
      compactions: this.compactions,
      updatedAt: new Date().toISOString(),
    };
  }

  snapshot(): StatsSnapshot {
    // Display = totais consolidados + turno em voo (parcial), p/ não mostrar 0
    // durante o 1º turno. Hit rate cumulativo = read / (read + write + input):
    // estável e informativo (eficiência do cache); turno frio inicial fica baixo.
    const input = this.inputTokens + this.curInput;
    const output = this.outputTokens + this.curOutput;
    const create = this.cacheCreateTokens + this.curCreate;
    const read = this.cacheReadTokens + this.curRead;
    const promptTotal = read + create + input;
    const hit = promptTotal > 0 ? read / promptTotal : 0;

    // Economia do cache: o que custaria se os tokens lidos tivessem sido input normal.
    const p = priceFor(this.model);
    const cacheSavingsUsd = read > 0 ? (read * (p.input - p.cacheRead)) / 1_000_000 : undefined;

    // Aceitação de ferramentas (só inclui se houve decisões).
    const toolAcceptance: ToolDecision[] | undefined =
      this.toolDecisions.size > 0
        ? [...this.toolDecisions.entries()].map(([tool, d]) => ({ tool, ...d }))
        : undefined;

    // Negações mais recentes primeiro (log de auditoria E5).
    const recentDenials: DenialEvent[] | undefined =
      this.denials.length > 0 ? [...this.denials].reverse() : undefined;

    return {
      model: this.model,
      mode: this.mode,
      sessionStartTs: this.sessionStartTs,
      contextUsed: this.contextUsed,
      contextLimit: this.contextLimit,
      contextBreakdown: undefined, // preenchido quando /context estiver disponível
      inputTokens: input,
      outputTokens: output,
      cacheCreateTokens: create,
      cacheReadTokens: read,
      cacheHitRate: hit,
      lastTurnHitRate: this.turnCount > 0 ? this.lastTurnHitRate : undefined,
      cacheSavingsUsd,
      sessionCostUsd: this.sessionCostUsd,
      lastTurnCostUsd: this.lastTurnCostUsd,
      costIsEstimate: this.costIsEstimate,
      toolAcceptance,
      recentDenials,
      turnCount: this.turnCount,
      reopenCount: this.reopenCount,
      cacheResetCount: this.cacheResetCount,
      cacheRecacheCostUsd: this.cacheRecacheCostUsd || undefined,
      compactionCount: this.compactionCount,
      peakContextUsed: this.peakContextUsed || undefined,
      activeMs: this.activeMs + this.liveTurnMs(),
      perModel: this.perModel.size > 0 ? [...this.perModel.values()] : undefined,
      // Vida do cache (TTL de 1h): idade desde a última atividade e quanto falta.
      ...this.cacheLife(),
      keepCacheAlive: this.keepCacheAlive,
      limits: {
        fiveHour: mergeWindow(this.limits.fiveHour, this.streamLimits.fiveHour),
        sevenDay: mergeWindow(this.limits.sevenDay, this.streamLimits.sevenDay),
      },
      // statusline (% real completo) tem prioridade; senão stream; senão estimativa.
      limitsSource:
        this.limitsSource === 'real' ? 'statusline' : this.streamSeen ? 'stream' : 'estimate',
    };
  }
}

/**
 * Mescla uma janela: stream tem prioridade em status/reset e no %, mas o %
 * cai para a base (statusline/estimativa) quando o stream não traz `utilization`
 * (uso baixo). usd/tokens locais vêm sempre da base.
 */
function mergeWindow(base?: LimitWindow, stream?: LimitWindow): LimitWindow | undefined {
  if (!base && !stream) return undefined;
  return {
    usedPct: stream?.usedPct ?? base?.usedPct,
    resetsAt: stream?.resetsAt ?? base?.resetsAt,
    status: stream?.status ?? base?.status,
    usd: base?.usd,
    tokens: base?.tokens,
  };
}
