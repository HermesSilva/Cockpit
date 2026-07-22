// Local OTLP/HTTP (JSON) receiver for Claude Code's opt-in telemetry.
// Starts an http.Server on 127.0.0.1 that accepts /v1/metrics and /v1/logs and aggregates the
// `claude_code.*` counters (LOC, sessions, commits, PRs, tool decisions).
//
// Why: it is the CLEAN, structured source from the CLI (no transcript scanning) for data
// stream-json doesn't carry — lines of code per model, edit decisions.
// Opt-in (setting tootega.otel.enabled, default OFF): it requires the user to turn on the CLI's
// OTEL. When turned on, we inject the export env vars into the host's process.env so
// the child `claude` processes export here. It NEVER logs credentials.
import * as http from 'node:http';
import type { OtelStats, UsageSlice } from '../../shared/protocol';
import { normalizeModel } from '../stats/StatsAggregator';
import { log, dlog } from '../util/logger';

const LOOPBACK = '127.0.0.1';

/** Aggregated, mutable state, fed by the OTLP data points. */
interface OtelState {
  sinceTs: number;
  linesAdded: number;
  linesRemoved: number;
  locByModel: Map<string, number>; // model -> lines (added)
  costByModel: Map<string, number>; // model -> REAL USD (claude_code.cost.usage)
  tokensByModel: Map<string, number>; // model -> REAL tokens (claude_code.token.usage)
  sessionCount: number;
  commitCount: number;
  prCount: number;
  decisions: Map<string, { accept: number; reject: number }>; // tool -> counts
  // Cost/tokens per workflow RUN. Since CLI 2.1.202 the agents spawned by a
  // workflow carry `workflow.run_id` / `workflow.name` in the attributes — that is what
  // lets us sum what a whole run spent (stream-json doesn't expose it). The
  // `effort` (low…max) came in 2.1.214/215, also on cost.usage/token.usage.
  workflows: Map<string, { name: string; usd: number; tokens: number; efforts: Set<string> }>;
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
    workflows: new Map(),
  };
}

/** Adds into the workflow run aggregate of the data point, when it belongs to one. */
function addWorkflow(st: OtelState, a: Record<string, string>, usd: number, tokens: number): void {
  const runId = a['workflow.run_id'];
  if (!runId) return;
  const cur =
    st.workflows.get(runId) ??
    { name: a['workflow.name'] || runId, usd: 0, tokens: 0, efforts: new Set<string>() };
  // The name may arrive on only some of the points; the first non-empty one wins.
  if (!cur.name || cur.name === runId) cur.name = a['workflow.name'] || cur.name;
  cur.usd += usd;
  cur.tokens += tokens;
  // A run may have agents with different efforts — we collect the set.
  if (a.effort) cur.efforts.add(a.effort);
  st.workflows.set(runId, cur);
}

// Canonical order to display a run's efforts (lowest → highest).
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
function sortEfforts(efforts: Set<string>): string[] {
  return [...efforts].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a);
    const ib = EFFORT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

/** Numeric value of an OTLP data point (asInt comes as a string in JSON). */
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

/** OTLP attribute map (list of {key,value:{stringValue|intValue|...}}) -> object. */
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
 * Aggregates an OTLP metrics payload (ExportMetricsServiceRequest in JSON) into the
 * state. Tolerant: unknown shapes are ignored without throwing. Exported
 * for unit testing (pure parsing, no network).
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
            case 'claude_code.cost.usage': {
              // REAL cost (USD) reported by the CLI itself, per model.
              const mk = normalizeModel(a.model) ?? 'unknown';
              st.costByModel.set(mk, (st.costByModel.get(mk) ?? 0) + v);
              addWorkflow(st, a, v, 0);
              break;
            }
            case 'claude_code.token.usage': {
              // REAL tokens per model (all categories summed).
              const mk = normalizeModel(a.model) ?? 'unknown';
              st.tokensByModel.set(mk, (st.tokensByModel.get(mk) ?? 0) + v);
              addWorkflow(st, a, 0, v);
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

  /** Turns the receiver on and injects the export env vars into the host (child `claude`
   *  processes export here). Idempotent. */
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

  /** Turns the receiver off and removes the injected env vars. */
  stop(): void {
    this.running = false;
    try {
      this.server?.close();
    } catch {
      /* ignored */
    }
    this.server = undefined;
    this.clearEnv();
  }

  /** Aggregates an OTLP metrics payload into the state (test/direct-use seam). */
  ingest(metricsBody: unknown): void {
    ingestMetrics(metricsBody, this.state);
  }

  /** Aggregated snapshot for the webview (Usage modal). undefined-safe. */
  stats(): OtelStats {
    // OTEL telemetry doesn't separate cache-read from the rest: cacheRead stays 0.
    const locByModel: UsageSlice[] = [...this.state.locByModel.entries()]
      .map(([key, lines]) => ({ key, usd: 0, tokens: lines, cacheRead: 0 }))
      .sort((a, b) => b.tokens - a.tokens);
    // REAL cost per model (cost.usage) + real tokens (token.usage) when present.
    const costByModel: UsageSlice[] = [...this.state.costByModel.entries()]
      .map(([key, usd]) => ({
        key,
        usd,
        tokens: this.state.tokensByModel.get(key) ?? 0,
        cacheRead: 0,
      }))
      .sort((a, b) => b.usd - a.usd);
    const toolDecisions = [...this.state.decisions.entries()]
      .map(([tool, d]) => ({ tool, accept: d.accept, reject: d.reject }))
      .sort((a, b) => b.accept + b.reject - (a.accept + a.reject));
    const workflows = [...this.state.workflows.entries()]
      .map(([runId, w]) => ({
        runId,
        name: w.name,
        usd: w.usd,
        tokens: w.tokens,
        effort: w.efforts.size ? sortEfforts(w.efforts).join(' · ') : undefined,
      }))
      .sort((a, b) => b.usd - a.usd);
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
      workflows: workflows.length ? workflows : undefined,
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
      if (body.length > 8 * 1024 * 1024) req.destroy(); // defensive cap
    });
    req.on('end', () => {
      if (url.endsWith('/v1/metrics')) {
        try {
          ingestMetrics(JSON.parse(body), this.state);
        } catch (e) {
          dlog('otel', `metrics parse failed: ${String(e)}`);
        }
      }
      // /v1/logs: accepted and discarded (assistant responses may contain text;
      // we don't aggregate it so no sensitive content is retained). It only acknowledges receipt.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  }

  /** OTLP/HTTP-JSON env vars for the `claude` processes to export to this receiver. */
  private applyEnv(): void {
    process.env.CLAUDE_CODE_ENABLE_TELEMETRY = '1';
    process.env.OTEL_METRICS_EXPORTER = 'otlp';
    process.env.OTEL_LOGS_EXPORTER = 'otlp';
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://${LOOPBACK}:${this.port}`;
    // Fast export so the data shows up in the modal without waiting for the default batch (60s).
    process.env.OTEL_METRIC_EXPORT_INTERVAL = '10000';
    // Conversation content does NOT enter the telemetry. Since CLI 2.1.193 the
    // `claude_code.assistant_response` event carries the response text, and it follows
    // `OTEL_LOG_USER_PROMPTS` when `OTEL_LOG_ASSISTANT_RESPONSES` is unset
    // — anyone already logging prompts would start logging responses. We pin both to 0: the
    // receiver already discards /v1/logs, but this way the text doesn't even leave the `claude` process.
    process.env.OTEL_LOG_USER_PROMPTS = '0';
    process.env.OTEL_LOG_ASSISTANT_RESPONSES = '0';
    // Brings the REAL `workflow.name` into the metrics: without it the CLI replaces
    // user-authored workflow names with "custom" (official monitoring docs). It only affects the label
    // in the workflows panel — the tool details this flag also exposes go
    // to /v1/logs, which we discard entirely. No content is retained.
    process.env.OTEL_LOG_TOOL_DETAILS = '1';
  }

  private clearEnv(): void {
    for (const k of [
      'CLAUDE_CODE_ENABLE_TELEMETRY',
      'OTEL_METRICS_EXPORTER',
      'OTEL_LOGS_EXPORTER',
      'OTEL_EXPORTER_OTLP_PROTOCOL',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_LOG_USER_PROMPTS',
      'OTEL_LOG_ASSISTANT_RESPONSES',
      'OTEL_LOG_TOOL_DETAILS',
    ]) {
      delete process.env[k];
    }
  }
}
