// Receiver OTLP/HTTP (JSON) local p/ a telemetria opt-in do Claude Code.
// Sobe um http.Server em 127.0.0.1 que aceita /v1/metrics e /v1/logs e agrega os
// contadores `claude_code.*` (LOC, sessões, commits, PRs, decisões de tool).
//
// Por quê: é a fonte LIMPA e estruturada da CLI (sem varrer transcript) p/ dados
// que o stream-json não traz — linhas de código por modelo, decisões de edição.
// Opt-in (setting tootega.otel.enabled, padrão OFF): exige o usuário ligar o OTEL
// do CLI. Ao ligar, injetamos as env vars de export no process.env do host para
// que os processos `claude` filhos exportem para cá. NUNCA registra credenciais.
import * as http from 'node:http';
import type { OtelStats, UsageSlice } from '../../shared/protocol';
import { normalizeModel } from '../stats/StatsAggregator';
import { log, dlog } from '../util/logger';

const LOOPBACK = '127.0.0.1';

/** Estado agregado, mutável, alimentado pelos data points OTLP. */
interface OtelState {
  sinceTs: number;
  linesAdded: number;
  linesRemoved: number;
  locByModel: Map<string, number>; // modelo -> linhas (added)
  costByModel: Map<string, number>; // modelo -> USD REAL (claude_code.cost.usage)
  tokensByModel: Map<string, number>; // modelo -> tokens REAIS (claude_code.token.usage)
  sessionCount: number;
  commitCount: number;
  prCount: number;
  decisions: Map<string, { accept: number; reject: number }>; // tool -> contagens
}

function emptyState(now: number): OtelState {
  return {
    sinceTs: now,
    linesAdded: 0,
    linesRemoved: 0,
    locByModel: new Map(),
    costByModel: new Map(),
    tokensByModel: new Map(),
    sessionCount: 0,
    commitCount: 0,
    prCount: 0,
    decisions: new Map(),
  };
}

/** Valor numérico de um data point OTLP (asInt vem como string no JSON). */
function pointValue(dp: any): number {
  if (dp == null) return 0;
  if (typeof dp.asInt === 'number') return dp.asInt;
  if (typeof dp.asInt === 'string') {
    const n = Number(dp.asInt);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof dp.asDouble === 'number' && Number.isFinite(dp.asDouble)) return dp.asDouble;
  return 0;
}

/** Mapa de atributos OTLP (lista {key,value:{stringValue|intValue|...}}) -> objeto. */
function attrs(dp: any): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(dp?.attributes) ? dp.attributes : [];
  for (const a of list) {
    const v = a?.value ?? {};
    const val =
      v.stringValue ??
      (v.intValue != null ? String(v.intValue) : undefined) ??
      (v.doubleValue != null ? String(v.doubleValue) : undefined) ??
      (v.boolValue != null ? String(v.boolValue) : undefined);
    if (typeof a?.key === 'string' && val != null) out[a.key] = String(val);
  }
  return out;
}

/**
 * Agrega um payload OTLP de métricas (ExportMetricsServiceRequest em JSON) no
 * estado. Tolerante: shapes desconhecidos são ignorados sem lançar. Exportado
 * para teste unitário (parsing puro, sem rede).
 */
export function ingestMetrics(body: any, st: OtelState): void {
  const rms = body?.resourceMetrics;
  if (!Array.isArray(rms)) return;
  for (const rm of rms) {
    for (const sm of rm?.scopeMetrics ?? []) {
      for (const m of sm?.metrics ?? []) {
        const name: string = typeof m?.name === 'string' ? m.name : '';
        const points: any[] = m?.sum?.dataPoints ?? m?.gauge?.dataPoints ?? [];
        for (const dp of points) {
          const v = pointValue(dp);
          if (v <= 0) continue;
          const a = attrs(dp);
          switch (name) {
            case 'claude_code.lines_of_code.count': {
              if (a.type === 'removed') st.linesRemoved += v;
              else {
                st.linesAdded += v;
                const model = normalizeModel(a.model) ?? 'unknown';
                st.locByModel.set(model, (st.locByModel.get(model) ?? 0) + v);
              }
              break;
            }
            case 'claude_code.cost.usage':
              // Custo REAL (USD) reportado pela própria CLI, por modelo.
              st.costByModel.set(
                normalizeModel(a.model) ?? 'unknown',
                (st.costByModel.get(normalizeModel(a.model) ?? 'unknown') ?? 0) + v,
              );
              break;
            case 'claude_code.token.usage': {
              // Tokens REAIS por modelo (todas as categorias somadas).
              const mk = normalizeModel(a.model) ?? 'unknown';
              st.tokensByModel.set(mk, (st.tokensByModel.get(mk) ?? 0) + v);
              break;
            }
            case 'claude_code.session.count':
              st.sessionCount += v;
              break;
            case 'claude_code.commit.count':
              st.commitCount += v;
              break;
            case 'claude_code.pull_request.count':
              st.prCount += v;
              break;
            case 'claude_code.code_edit_tool.decision': {
              const tool = a.tool_name ?? a.tool ?? 'tool';
              const d = st.decisions.get(tool) ?? { accept: 0, reject: 0 };
              if (a.decision === 'reject') d.reject += v;
              else d.accept += v;
              st.decisions.set(tool, d);
              break;
            }
          }
        }
      }
    }
  }
}

export class OtelReceiver {
  private server?: http.Server;
  private state: OtelState;
  private port: number;
  private running = false;

  constructor(port = 4318) {
    this.port = port;
    this.state = emptyState(Date.now());
  }

  /** Liga o receiver e injeta as env vars de export no host (filhos `claude`
   *  exportam p/ cá). Idempotente. */
  start(): void {
    if (this.running) return;
    const srv = http.createServer((req, res) => this.onRequest(req, res));
    srv.on('error', (e) => log(`[otel] server error: ${String(e)}`));
    srv.listen(this.port, LOOPBACK, () => {
      this.running = true;
      this.applyEnv();
      log(`[otel] receiver em http://${LOOPBACK}:${this.port} (opt-in)`);
    });
    this.server = srv;
  }

  /** Desliga o receiver e remove as env vars injetadas. */
  stop(): void {
    this.running = false;
    try {
      this.server?.close();
    } catch {
      /* ignora */
    }
    this.server = undefined;
    this.clearEnv();
  }

  /** Agrega um payload OTLP de métricas no estado (seam de teste/uso direto). */
  ingest(metricsBody: unknown): void {
    ingestMetrics(metricsBody, this.state);
  }

  /** Snapshot agregado p/ o webview (modal Usage). undefined-safe. */
  stats(): OtelStats {
    const locByModel: UsageSlice[] = [...this.state.locByModel.entries()]
      .map(([key, lines]) => ({ key, usd: 0, tokens: lines }))
      .sort((a, b) => b.tokens - a.tokens);
    // Custo REAL por modelo (cost.usage) + tokens reais (token.usage) quando houver.
    const costByModel: UsageSlice[] = [...this.state.costByModel.entries()]
      .map(([key, usd]) => ({ key, usd, tokens: this.state.tokensByModel.get(key) ?? 0 }))
      .sort((a, b) => b.usd - a.usd);
    const toolDecisions = [...this.state.decisions.entries()]
      .map(([tool, d]) => ({ tool, accept: d.accept, reject: d.reject }))
      .sort((a, b) => b.accept + b.reject - (a.accept + a.reject));
    return {
      enabled: this.running,
      endpoint: `http://${LOOPBACK}:${this.port}`,
      sinceTs: this.state.sinceTs,
      linesAdded: this.state.linesAdded,
      linesRemoved: this.state.linesRemoved,
      locByModel: locByModel.length ? locByModel : undefined,
      costByModel: costByModel.length ? costByModel : undefined,
      sessionCount: this.state.sessionCount || undefined,
      commitCount: this.state.commitCount || undefined,
      prCount: this.state.prCount || undefined,
      toolDecisions: toolDecisions.length ? toolDecisions : undefined,
    };
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !(url.endsWith('/v1/metrics') || url.endsWith('/v1/logs'))) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy(); // teto defensivo
    });
    req.on('end', () => {
      if (url.endsWith('/v1/metrics')) {
        try {
          ingestMetrics(JSON.parse(body), this.state);
        } catch (e) {
          dlog('otel', `metrics parse falhou: ${String(e)}`);
        }
      }
      // /v1/logs: aceito e descartado (responses do assistant podem conter texto;
      // não agregamos p/ não reter conteúdo sensível). Apenas confirma o recebimento.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }

  /** Env vars OTLP/HTTP-JSON p/ os processos `claude` exportarem p/ este receiver. */
  private applyEnv(): void {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_METRICS_EXPORTER = 'otlp';
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://${LOOPBACK}:${this.port}`;
    // Export rápido p/ o dado aparecer no modal sem esperar o batch padrão (60s).
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '10000';
  }

  private clearEnv(): void {
    for (const k of [
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'OTEL_METRICS_EXPORTER',
      'OTEL_LOGS_EXPORTER',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_METRIC_EXPORT_INTERVAL',
    ]) {
      delete process.env[k];
    }
  }
}
