// Agrega usage dos eventos em um StatsSnapshot para a UI.
// Cobre contexto, cache, custo e (quando disponível) limites da conta.
import type { ClaudeEvent, Usage } from '../../shared/events';
import type { StatsSnapshot, LimitWindow, ToolDecision } from '../../shared/protocol';

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
  private costIsEstimate = true;

  private sessionStartTs?: number;
  private toolDecisions = new Map<string, { allow: number; allowAlways: number; deny: number }>();

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
    if (!model) return;
    if (authoritative) {
      this.model = model;
      if (this.autoLimit) this.contextLimit = deriveContextLimit(model);
    } else if (!this.model) {
      this.model = model;
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

  /** Registra decisão de permissão do usuário (allow/deny) por ferramenta. */
  recordDecision(tool: string, decision: 'allow' | 'deny' | 'allow_always'): void {
    const entry = this.toolDecisions.get(tool) ?? { allow: 0, allowAlways: 0, deny: 0 };
    if (decision === 'allow') entry.allow++;
    else if (decision === 'allow_always') entry.allowAlways++;
    else entry.deny++;
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
    if (typeof u.output_tokens === 'number') this.curOutput = u.output_tokens;
  }

  /** input_tokens + cache_* da requisição = tamanho do prompt (≈ contexto usado). */
  private applyPromptUsage(u: Usage, isFinal = false) {
    const inp = u.input_tokens ?? 0;
    const cw = u.cache_creation_input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const out = u.output_tokens ?? 0;

    this.contextUsed = inp + cw + cr;

    if (isFinal) {
      // Consolida o turno nos totais da sessão e zera o turno em voo.
      this.inputTokens += inp;
      this.cacheCreateTokens += cw;
      this.cacheReadTokens += cr;
      this.outputTokens += out;
      this.curInput = this.curCreate = this.curRead = this.curOutput = 0;

      if (this.costIsEstimate) {
        const p = priceFor(this.model);
        const turn =
          (inp * p.input + cw * p.cacheWrite + cr * p.cacheRead + out * p.output) / 1_000_000;
        this.lastTurnCostUsd = turn;
        this.sessionCostUsd += turn;
      }
    } else {
      // message_start (parcial): reflete o turno atual no display de imediato.
      this.curInput = inp;
      this.curCreate = cw;
      this.curRead = cr;
      this.curOutput = out;
    }
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
      cacheSavingsUsd,
      sessionCostUsd: this.sessionCostUsd,
      lastTurnCostUsd: this.lastTurnCostUsd,
      costIsEstimate: this.costIsEstimate,
      toolAcceptance,
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
