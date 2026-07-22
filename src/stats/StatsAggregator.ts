// Aggregates event usage into a StatsSnapshot for the UI.
// Covers context, cache, cost and (when available) account limits.
import type { ClaudeEvent, Usage } from '../../shared/events';
import type {
  StatsSnapshot,
  LimitWindow,
  ToolDecision,
  ModelUsage,
  TimelineSample,
  CompactionEvent,
  DenialEvent,
  SkillState,
  SkillOverride,
} from '../../shared/protocol';
import type { ContextUsageInfo } from '../cli/ContextUsage';
import { STATS_VERSION, capTimeline, type PersistedStats } from './StatsStore';
import { dlog } from '../util/logger';

// Prompt cache life (Claude Code's extended 1h TTL): after this much idle
// time the cached prefix expires and the next turn rewrites everything (cold
// reset). Every request that hits the prefix RESTARTS this window — that's the basis of the
// keep-alive (re-sending before the hour is up). Exported for the CacheKeeper.
export const CACHE_LIFE_MS = 60 * 60_000;
// A turn is a TTL reset if: it isn't the first, it idled > the cache life, it read almost
// nothing from the cache and it rewrote the prefix. Conservative, to avoid counting false positives.
const COLD_READ_FRAC = 0.1;
// Compaction: the TOTAL context shrank below this fraction of the previous turn.
// (A cold reset does NOT shrink the total — it only shifts read→create — so they don't collide.)
const COMPACT_FRAC = 0.6;
// Denials kept in the log (E5): the last N, enough to audit the session.
const DENIAL_CAP = 50;
// Cap of the tool_use_id → error text map (almost every error is NOT a denial).
const DENIAL_REASON_CAP = 200;
// The reason is a UI label, not a log: truncated before it becomes a paragraph.
const REASON_MAX = 300;
// Prefixo da mensagem `user` sintética que o CLI injeta com o corpo do SKILL.md logo
// depois do tool_result do `Skill`. É o único vestígio do corpo no stream — daí sai a
// ESTIMATIVA de tokens da skill ativa (o CLI não atribui esses tokens por skill).
const SKILL_BODY_PREFIX = 'Base directory for this skill:';
// tool_result do `Skill` quando o CLI de fato CARREGA o SKILL.md no contexto. Existe um
// segundo caminho ("Execute skill: <nome>", usado por skills built-in do tipo execute) que
// NÃO injeta corpo nenhum — nesse caso nada entra no contexto e nada é marcado.
const SKILL_LAUNCH_PREFIX = 'Launching skill:';
// Teto do mapa tool_use_id → skill (sessão longa não deve crescer sem limite).
const SKILL_TOOLUSE_CAP = 200;
// tool_result em texto: 4 chars ≈ 1 token (mesma aproximação do UsageAggregator).
const CHARS_PER_TOKEN = 4;

// Prices per 1M tokens (USD). An estimate — labelled as such in the UI.
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

/** Estimated cost (USD) of a usage block, from the model's price table. */
export function estimateCost(u: Usage, model?: string): number {
  const p = priceFor(model);
  const inp = u.input_tokens ?? 0;
  const cw = u.cache_creation_input_tokens ?? 0;
  const cr = u.cache_read_input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  return (inp * p.input + cw * p.cacheWrite + cr * p.cacheRead + out * p.output) / 1_000_000;
}

// Real contexts per model (normalized id without [1m], lowercase), populated by
// discovery via /v1/models. It is the source of truth for natively-1M models that do NOT
// carry the [1m] suffix (e.g. Claude Fable 5, Sonnet 5).
const knownContextLimits = new Map<string, number>();

/** Context lookup key: id without the [1m] suffix, lowercased. */
function ctxKey(model: string): string {
  return model.replace(/\[1m\]/i, '').toLowerCase();
}

/** Records a model's real context (discovery). Ignores invalid values. */
export function registerModelContext(model: string, tokens?: number): void {
  if (!model || !tokens || tokens <= 0) return;
  knownContextLimits.set(ctxKey(model), tokens);
}

/**
 * Claude Code's effective limit:
 *  - [1m] suffix → 1M;
 *  - known real context (/v1/models discovery) → uses that;
 *  - the Claude 5 family (…-5) is natively 1M even without [1m] (fallback before discovery);
 *  - otherwise 200K.
 */
export function deriveContextLimit(model?: string): number {
  if (!model) return 200_000;
  if (/\[1m\]/i.test(model)) return 1_000_000;
  const known = knownContextLimits.get(ctxKey(model));
  if (known) return known;
  if (/(?:fable|sonnet|opus|haiku|mythos)-5\b/i.test(model)) return 1_000_000;
  return 200_000;
}

/**
 * Normalizes the model id: collapses repeated [1m] suffixes. The CLI already normalizes
 * (2.1.172/173: `[1M][1m]` became a duplicate), but resumed old events can
 * carry the duplicated id — defensive, so the display isn't inflated nor the price confused.
 */
export function normalizeModel(model?: string): string | undefined {
  if (!model) return model;
  return model.replace(/(\[1m\])(\[1m\])+/gi, '$1');
}

/** Defensive coercion for a token count coming from the stream: finite number ≥ 0. */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Text of an error `tool_result`. The `content` may be a string or the API's
 * rich blocks (`[{type:'text', text}]`) — both are accepted, the rest is ignored.
 */
function toolErrorText(content: unknown): string {
  let raw = '';
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content
      .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join(' ');
  }
  raw = raw.replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw.length > REASON_MAX ? `${raw.slice(0, REASON_MAX - 1)}…` : raw;
}

/** Texto de um tool_result (string ou blocos), sem truncar — usado só para prefixos. */
function resultText(block: unknown): string {
  const content = (block as any)?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
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
  // Turn in flight (partial via message_start): reflected in the display until the
  // assistant event consolidates it into the totals. Prevents the panel from showing 0 during the first turn
  // (cold/slow), when the context is already full but the totals haven't accumulated yet.
  private curInput = 0;
  private curOutput = 0;
  private curCreate = 0;
  private curRead = 0;

  private sessionCostUsd = 0;
  private lastTurnCostUsd = 0;
  private lastTurnHitRate = 0; // cr/total of the last consolidated turn
  private costIsEstimate = true;

  private sessionStartTs?: number;
  private toolDecisions = new Map<string, { allow: number; allowAlways: number; deny: number }>();
  // Denial log (E5): the last DENIAL_CAP, most recent at the end.
  private denials: DenialEvent[] = [];
  // Error reason per tool_use_id, waiting for the `result` to say whether it was a denial.
  private denialReasons = new Map<string, string>();
  // tool_use_id already counted as an engine denial (the `result` may repeat it).
  private seenDenials = new Set<string>();

  // --- Counters that survive a context reopen ---
  private turnCount = 0;
  private reopenCount = 0;
  private cacheResetCount = 0;
  private cacheRecacheCostUsd = 0;
  private compactionCount = 0;
  private peakContextUsed = 0;
  private peakContextTs?: number;
  // REAL execution time: sum of the time of each prompt (send → result/stop).
  // It does NOT include idleness (agent stopped). turnStartTs marks the turn in flight.
  private activeMs = 0;
  private turnStartTs?: number;
  // Keep-alive: when ticked, the CacheKeeper re-sends this context before the 1h
  // cache expires (even with the tab/context closed). Persisted state.
  private keepCacheAlive = false;
  // State for between-turn detection.
  private prevContextUsed = 0;
  private prevCacheRead = 0;
  private lastTurnTs = 0;
  // Breakdown per model and historical series.
  private perModel = new Map<string, ModelUsage>();
  private timeline: TimelineSample[] = [];
  private compactions: CompactionEvent[] = [];

  private limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } = {};
  private limitsSource: 'real' | 'estimate' = 'estimate';
  // Separate channel: limits coming from the stream (rate_limit_event). Not touched by
  // setLimits (statusline/periodic estimate), and it wins the merge.
  private streamLimits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow } = {};
  private streamSeen = false;

  // --- Skills ---
  // Metadados do listing (get_context_usage): nome → {source, tokens}.
  private skillMeta = new Map<string, { source?: string; tokens?: number }>();
  private skillsListingTokens?: number;
  private skillsTotal?: number;
  private skillsListed?: number;
  // Skills cujo corpo já entrou no contexto desta sessão. Não há como descarregar
  // uma delas pelo engine: só sai com /clear ou sessão nova.
  private skillsActive = new Map<
    string,
    { at: number; by: 'model' | 'user'; tokens?: number }
  >();
  // tool_use_id do `Skill` → nome, para ler o tool_result correspondente.
  private skillByToolUse = new Map<string, string>();
  // Skill que já teve o "Launching skill:" e espera a mensagem com o corpo.
  private skillAwaitingBody?: string;
  // Overrides em vigor (só para exibir na UI; quem aplica é o spawn do CLI).
  private skillOverrides: Record<string, SkillOverride> = {};

  // configuredLimit > 0 = manual override; 0 = auto (derived from the active model).
  constructor(configuredLimit: number) {
    if (configuredLimit > 0) {
      this.contextLimit = configuredLimit;
      this.autoLimit = false;
    } else {
      this.contextLimit = deriveContextLimit(undefined);
      this.autoLimit = true;
    }
  }

  // authoritative=true (init / override): defines the display and the limit (carries the [1m]).
  // authoritative=false (per-message events): the API id comes WITHOUT the [1m] suffix;
  // it must not overwrite the session model nor downgrade the limit to 200K.
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

  // Recomputes the active model's limit (auto). Called when model discovery
  // arrives AFTER the session init — otherwise the limit would be stuck at 200K
  // for natively-1M models without the [1m] suffix (e.g. Fable 5). Returns true when it changed.
  refreshContextLimit(): boolean {
    if (!this.autoLimit || !this.model) return false;
    const next = deriveContextLimit(this.model);
    if (next === this.contextLimit) return false;
    this.contextLimit = next;
    return true;
  }

  /** Account limits (real via statusline, or a local estimate). */
  setLimits(
    limits: { fiveHour?: LimitWindow; sevenDay?: LimitWindow },
    source: 'real' | 'estimate' = 'estimate',
  ) {
    this.limits = limits;
    this.limitsSource = source;
  }

  /**
   * Limit of a window coming from the stream (rate_limit_event). Merged per bucket
   * (events arrive one bucket at a time), preserving the other window.
   */
  setStreamLimit(which: 'fiveHour' | 'sevenDay', win: LimitWindow) {
    this.streamLimits[which] = { ...this.streamLimits[which], ...win };
    this.streamSeen = true;
  }

  // ---- Skills ----

  /** Metadados do listing vindos do `get_context_usage` (não gasta turno). */
  applyContextUsage(info: ContextUsageInfo): void {
    this.skillMeta.clear();
    for (const s of info.skills) this.skillMeta.set(s.name, { source: s.source, tokens: s.tokens });
    this.skillsListingTokens = info.listingTokens;
    this.skillsTotal = info.totalSkills;
    this.skillsListed = info.includedSkills;
  }

  /** Overrides em vigor nesta sessão (aplicados no spawn via --settings). */
  setSkillOverrides(map: Record<string, SkillOverride>): void {
    this.skillOverrides = { ...map };
  }

  /**
   * Marca uma skill como ATIVA (corpo do SKILL.md no contexto). `tokens` só existe
   * quando conseguimos medir o corpo injetado; numa invocação por /nome o engine não
   * emite nada e o custo fica desconhecido — melhor omitir do que inventar.
   */
  markSkillActive(name: string, by: 'model' | 'user', tokens?: number): void {
    if (!name) return;
    const cur = this.skillsActive.get(name);
    this.skillsActive.set(name, {
      at: cur?.at ?? Date.now(),
      by: cur?.by ?? by,
      tokens: tokens ?? cur?.tokens,
    });
  }

  /**
   * tool_use `Skill` = o MODELO acionou uma skill. Não marca nada ainda: acionar não é
   * o mesmo que carregar (ver SKILL_LAUNCH_PREFIX). Só guarda o id → nome para ler o
   * tool_result correspondente.
   */
  private noteSkillToolUse(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== 'tool_use' || b.name !== 'Skill') continue;
      const name = typeof b.input?.skill === 'string' ? b.input.skill.replace(/^\//, '') : '';
      if (!name || typeof b.id !== 'string') continue;
      if (this.skillByToolUse.size > SKILL_TOOLUSE_CAP) this.skillByToolUse.clear();
      this.skillByToolUse.set(b.id, name);
    }
  }

  /**
   * Dois sinais na mensagem `user` que fecha o acionamento:
   *  - tool_result "Launching skill: X" → o corpo do SKILL.md ENTROU no contexto;
   *  - a mensagem sintética "Base directory for this skill: …" + corpo, logo em seguida,
   *    de onde sai a ESTIMATIVA de tokens.
   * Sem o segundo (versão de CLI diferente) a skill fica ativa sem número — melhor faltar
   * o dado do que exibir um valor inventado.
   */
  private noteSkillBody(content: unknown[]): void {
    for (const b of content) {
      const type = (b as any)?.type;
      if (type === 'tool_result') {
        const name = this.skillByToolUse.get((b as any).tool_use_id);
        if (!name) continue;
        this.skillByToolUse.delete((b as any).tool_use_id);
        if (!resultText(b).startsWith(SKILL_LAUNCH_PREFIX)) continue; // "Execute skill:" não carrega nada
        this.markSkillActive(name, 'model');
        this.skillAwaitingBody = name;
        continue;
      }
      if (type !== 'text' || !this.skillAwaitingBody) continue;
      const text = (b as any).text;
      if (typeof text !== 'string' || !text.startsWith(SKILL_BODY_PREFIX)) continue;
      this.markSkillActive(this.skillAwaitingBody, 'model', Math.round(text.length / CHARS_PER_TOKEN));
      this.skillAwaitingBody = undefined;
    }
  }

  /** Skills conhecidas (listadas + ativas), maior custo de metadados primeiro. */
  private skillStates(): SkillState[] | undefined {
    const names = new Set([...this.skillMeta.keys(), ...this.skillsActive.keys()]);
    if (names.size === 0) return undefined;
    const out: SkillState[] = [];
    for (const name of names) {
      const meta = this.skillMeta.get(name);
      const act = this.skillsActive.get(name);
      out.push({
        name,
        source: meta?.source,
        metaTokens: meta?.tokens,
        listed: this.skillMeta.has(name),
        override: this.skillOverrides[name],
        active: act ? true : undefined,
        activeTokens: act?.tokens,
        activatedAt: act?.at,
        invokedBy: act?.by,
      });
    }
    // Ativas primeiro (é o que pesa no contexto), depois por tokens de metadados.
    return out.sort(
      (a, b) =>
        Number(!!b.active) - Number(!!a.active) ||
        (b.activeTokens ?? 0) - (a.activeTokens ?? 0) ||
        (b.metaTokens ?? 0) - (a.metaTokens ?? 0) ||
        a.name.localeCompare(b.name),
    );
  }

  /** Records the user's permission decision (allow/deny) per tool. On
   *  denials it also stores the entry in the log (with the reason, when there is one). */
  recordDecision(tool: string, decision: 'allow' | 'deny' | 'allow_always', reason?: string): void {
    const entry = this.toolDecisions.get(tool) ?? { allow: 0, allowAlways: 0, deny: 0 };
    if (decision === 'allow') entry.allow++;
    else if (decision === 'allow_always') entry.allowAlways++;
    else {
      entry.deny++;
      this.pushDenial(tool, 'user', reason);
    }
    this.toolDecisions.set(tool, entry);
  }

  /** Appends to the denial log, respecting the cap. */
  private pushDenial(tool: string, source: 'user' | 'engine', reason?: string): void {
    const clean = typeof reason === 'string' ? reason.trim() : '';
    this.denials.push({ tool, ts: Date.now(), source, reason: clean || undefined });
    if (this.denials.length > DENIAL_CAP) this.denials = this.denials.slice(-DENIAL_CAP);
  }

  /**
   * Denials decided by the ENGINE (auto mode, tool outside the allowlist, a write outside
   * the workspace). They arrive in the `result` event as `permission_denials[]`, which brings the
   * tool but NOT the reason — that comes in the error `tool_result` text of the same
   * `tool_use_id` (since 2.1.193 auto mode explains why it denied). Deduplicated by
   * `tool_use_id`: a turn's `result` may repeat denials already counted.
   */
  private recordEngineDenials(denials: unknown): void {
    if (!Array.isArray(denials)) return;
    for (const d of denials) {
      const id = typeof d?.tool_use_id === 'string' ? d.tool_use_id : '';
      const tool = typeof d?.tool_name === 'string' && d.tool_name ? d.tool_name : 'unknown';
      if (id && this.seenDenials.has(id)) continue;
      if (id) this.seenDenials.add(id);
      const entry = this.toolDecisions.get(tool) ?? { allow: 0, allowAlways: 0, deny: 0 };
      entry.deny++;
      this.toolDecisions.set(tool, entry);
      this.pushDenial(tool, 'engine', id ? this.denialReasons.get(id) : undefined);
      if (id) this.denialReasons.delete(id);
    }
  }

  /**
   * Stores the text of an error `tool_result` per `tool_use_id`. Most are ordinary
   * execution errors and will never be used — it is only consumed if the turn's `result`
   * lists that `tool_use_id` in `permission_denials`. Capped so it doesn't leak memory.
   */
  private noteToolError(id: unknown, content: unknown): void {
    if (typeof id !== 'string' || !id) return;
    const text = toolErrorText(content);
    if (!text) return;
    if (this.denialReasons.size > DENIAL_REASON_CAP) this.denialReasons.clear();
    this.denialReasons.set(id, text);
  }

  /** Processes an event and returns the updated snapshot. */
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
          this.setModel(raw.message?.model, false); // API id, without [1m]
          if (raw.message?.usage) this.applyPromptUsage(raw.message.usage);
        } else if (raw?.type === 'message_delta' && raw.usage) {
          // Cumulative output of the turn in flight (real time, token by token).
          this.applyDeltaUsage(raw.usage);
        }
        break;
      }
      case 'assistant': {
        const usage = (ev as any).message?.usage as Usage | undefined;
        this.setModel((ev as any).message?.model, false); // API id, without [1m]
        if (usage) this.applyPromptUsage(usage, true);
        this.noteSkillToolUse((ev as any).message?.content);
        break;
      }
      case 'user': {
        // Error tool_result: stores the text — it becomes the REASON if the turn's `result`
        // says this tool_use_id was denied (auto mode).
        const content = (ev as any).message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'tool_result' && b.is_error) this.noteToolError(b.tool_use_id, b.content);
          }
          this.noteSkillBody(content);
        }
        break;
      }
      case 'result': {
        const r = ev as any;
        if (typeof r.total_cost_usd === 'number') {
          // Real turn cost reported by the CLI.
          this.lastTurnCostUsd = Math.max(0, r.total_cost_usd - this.sessionCostUsd);
          this.sessionCostUsd = r.total_cost_usd;
          this.costIsEstimate = false;
        }
        this.recordEngineDenials(r.permission_denials);
        break;
      }
    }
    return this.snapshot();
  }

  /**
   * message_delta: usage with the turn-in-flight cumulative `output_tokens`. It updates
   * ONLY the output in real time — input/cache are fixed at message_start and must NOT
   * be touched here: the delta carries an incremental `input_tokens` (= 0 mid-stream),
   * which would zero the displayed input/context and make the number "blink".
   * The final `assistant` event consolidates it into the totals.
   */
  private applyDeltaUsage(u: Usage) {
    // Defensive guard: malformed deltas (NaN/negative) must not zero out or pollute
    // the display. output_tokens is cumulative within the turn — it only goes up.
    const out = num(u.output_tokens);
    if (out > this.curOutput) this.curOutput = out;
  }

  /** input_tokens + cache_* of the request = prompt size (≈ context used). */
  private applyPromptUsage(u: Usage, isFinal = false) {
    const inp = num(u.input_tokens);
    const cw = num(u.cache_creation_input_tokens);
    const cr = num(u.cache_read_input_tokens);
    const out = num(u.output_tokens);

    this.contextUsed = inp + cw + cr;

    if (isFinal) {
      // Consolidates the turn into the session totals and clears the turn in flight.
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
      // message_start (partial): reflects the current turn in the display right away.
      this.curInput = inp;
      this.curCreate = cw;
      this.curRead = cr;
      this.curOutput = out;
    }
  }

  /**
   * Post-consolidation of a turn: detects a cache reset (cold TTL) and compaction,
   * updates counters, peak, per-model breakdown and the timeline sample.
   */
  private consolidateTurn(inp: number, out: number, cw: number, cr: number, turnCost: number, p: Price): void {
    const now = Date.now();
    const total = inp + cw + cr; // = contextUsed do turno
    const readFrac = total > 0 ? cr / total : 0;
    const gap = this.lastTurnTs > 0 ? now - this.lastTurnTs : 0;

    // Cache reset (cold TTL): non-initial turn, idle > TTL, read ~0 from the cache and
    // rewrote the prefix. It re-pays the cacheWrite — the loss is accounted for.
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

    // Compaction: the TOTAL context shrank vs. the previous turn (and it wasn't a reset).
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
        `compaction #${this.compactionCount}: ${this.prevContextUsed} → ${total} tok (−${this.prevContextUsed - total})`,
      );
    }

    this.turnCount++;
    if (total > this.peakContextUsed) {
      this.peakContextUsed = total;
      this.peakContextTs = now;
    }

    // Per-model accumulation (per-model cost is always a table estimate).
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

  /** Records a reopen/resume of this context (increments reopenCount). */
  markReopen(): void {
    this.reopenCount++;
  }

  /** Turns this context's cache keep-alive on/off (persisted). */
  setKeepCacheAlive(v: boolean): void {
    this.keepCacheAlive = v;
  }

  /** Start of a prompt (send): arms the active execution-time stopwatch. */
  beginTurn(): void {
    if (this.turnStartTs == null) this.turnStartTs = Date.now();
  }

  /** End of the prompt (result/interrupt/stop): adds the worked time, ignores idle time. */
  endTurn(): void {
    if (this.turnStartTs != null) {
      this.activeMs += Math.max(0, Date.now() - this.turnStartTs);
      this.turnStartTs = undefined;
    }
  }

  /** Time of the turn in flight (so the display can add it to activeMs without closing the turn). */
  private liveTurnMs(): number {
    return this.turnStartTs != null ? Math.max(0, Date.now() - this.turnStartTs) : 0;
  }

  /**
   * Cache life: age since the last request (lastTurnTs) and how much is left
   * before the 1h window expires. Undefined while there has been no turn.
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
      cacheExpiresAt: this.lastTurnTs + CACHE_LIFE_MS, // epoch ms — for the live countdown in the UI
      cacheAlive: age < CACHE_LIFE_MS,
    };
  }

  /** Timeline + compactions for the `statsTimeline` message (sent per turn). */
  timelineSnapshot(): { timeline: TimelineSample[]; compactions: CompactionEvent[] } {
    return { timeline: this.timeline, compactions: this.compactions };
  }

  /** Restores the accumulators from a persisted state (coherent continuation). */
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
    // Last turn's hit rate rebuilt from the persisted pair (cr/total).
    this.lastTurnHitRate = p.lastContextUsed > 0 ? p.lastCacheRead / p.lastContextUsed : 0;
    this.lastTurnTs = p.lastTurnTs;
    this.perModel = new Map(Object.entries(p.perModel ?? {}));
    this.toolDecisions = new Map(Object.entries(p.toolDecisions ?? {}));
    this.denials = Array.isArray(p.denials) ? p.denials.slice(-DENIAL_CAP) : [];
    this.timeline = Array.isArray(p.timeline) ? p.timeline : [];
    this.compactions = Array.isArray(p.compactions) ? p.compactions : [];
  }

  /** Serializes the state for per-session persistence. `cwd` lets the CacheKeeper
   *  resume the context (claude --resume in the right folder) with the tab closed. */
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
    // Display = consolidated totals + turn in flight (partial), so it doesn't show 0
    // during the first turn. Cumulative hit rate = read / (read + write + input):
    // stable and informative (cache efficiency); the initial cold turn stays low.
    const input = this.inputTokens + this.curInput;
    const output = this.outputTokens + this.curOutput;
    const create = this.cacheCreateTokens + this.curCreate;
    const read = this.cacheReadTokens + this.curRead;
    const promptTotal = read + create + input;
    const hit = promptTotal > 0 ? read / promptTotal : 0;

    // Cache savings: what it would cost if the read tokens had been normal input.
    const p = priceFor(this.model);
    const cacheSavingsUsd = read > 0 ? (read * (p.input - p.cacheRead)) / 1_000_000 : undefined;

    // Tool acceptance (only included when there were decisions).
    const toolAcceptance: ToolDecision[] | undefined =
      this.toolDecisions.size > 0
        ? [...this.toolDecisions.entries()].map(([tool, d]) => ({ tool, ...d }))
        : undefined;

    // Most recent denials first (E5 audit log).
    const recentDenials: DenialEvent[] | undefined =
      this.denials.length > 0 ? [...this.denials].reverse() : undefined;

    return {
      model: this.model,
      mode: this.mode,
      sessionStartTs: this.sessionStartTs,
      contextUsed: this.contextUsed,
      contextLimit: this.contextLimit,
      contextBreakdown: undefined, // filled in once /context is available
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
      // Cache life (1h TTL): age since the last activity and how much is left.
      ...this.cacheLife(),
      keepCacheAlive: this.keepCacheAlive,
      limits: {
        fiveHour: mergeWindow(this.limits.fiveHour, this.streamLimits.fiveHour),
        sevenDay: mergeWindow(this.limits.sevenDay, this.streamLimits.sevenDay),
      },
      // statusline (real complete %) wins; otherwise stream; otherwise the estimate.
      limitsSource:
        this.limitsSource === 'real' ? 'statusline' : this.streamSeen ? 'stream' : 'estimate',
      skills: this.skillStates(),
      skillsListingTokens: this.skillsListingTokens,
      skillsTotal: this.skillsTotal,
      skillsListed: this.skillsListed,
    };
  }
}

/**
 * Merges a window: the stream wins on status/reset and on the %, but the %
 * falls back to the base (statusline/estimate) when the stream doesn't carry `utilization`
 * (low usage). Local usd/tokens always come from the base.
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
