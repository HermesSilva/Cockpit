// Uso REAL da conta via endpoint OAuth do Claude (mesma fonte do /usage do CLI).
// GET https://api.anthropic.com/api/oauth/usage — read-only, NÃO gasta token.
// Usa o accessToken OAuth de ~/.claude/.credentials.json (só leitura; nunca grava
// nem registra credenciais). Cache curto em memória p/ não repetir a cada refresh.
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LimitWindow, ScopedBucket } from '../../shared/protocol';
import { dlog } from '../util/logger';

export interface ApiUsage {
  fiveHour?: LimitWindow; // kind:'session'
  sevenDay?: LimitWindow; // kind:'weekly_all'
  weeklyScoped?: ScopedBucket[]; // kind:'weekly_scoped' (um por modelo escopado)
}

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const TTL_MS = 30_000;
let cache: { at: number; data?: ApiUsage } | undefined;

/** accessToken OAuth (só leitura). O servidor é a autoridade sobre validade. */
function readToken(): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const tok = o?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/** Janela da API ({utilization|percent:0..100, resets_at}) -> LimitWindow (usedPct 0..1). */
function win(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const pct = typeof w.utilization === 'number' ? w.utilization : w.percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = typeof w.resets_at === 'string' ? w.resets_at : undefined;
  return { usedPct: Math.max(0, Math.min(1, pct / 100)), resetsAt };
}

/**
 * Extrai as janelas do payload. Formato atual: array `limits[]` com
 * `kind` = session | weekly_all | weekly_scoped, e `scope.model.display_name`
 * nomeando o modelo da janela escopada (era `seven_day_opus`/`_sonnet` fixos).
 * Cai nos campos legados de topo quando `limits[]` não vem.
 */
export function parseUsage(j: any): ApiUsage {
  const out: ApiUsage = {};
  const scoped: ScopedBucket[] = [];
  if (Array.isArray(j?.limits)) {
    for (const l of j.limits) {
      const w = win(l);
      if (!w) continue;
      if (l.kind === 'session') out.fiveHour = w;
      else if (l.kind === 'weekly_all') out.sevenDay = w;
      else if (l.kind === 'weekly_scoped') {
        const label = l?.scope?.model?.display_name;
        if (typeof label === 'string' && label) scoped.push({ ...w, label });
      }
    }
  }
  out.fiveHour ??= win(j?.five_hour);
  out.sevenDay ??= win(j?.seven_day);
  if (!scoped.length) {
    // Legado: janelas semanais por modelo em campos fixos de topo.
    for (const [label, key] of [
      ['Opus', 'seven_day_opus'],
      ['Sonnet', 'seven_day_sonnet'],
    ] as const) {
      const w = win(j?.[key]);
      if (w) scoped.push({ ...w, label });
    }
  }
  if (scoped.length) out.weeklyScoped = scoped;
  return out;
}

/**
 * Busca o uso real da conta. Cache de 30s (use force=true no clique do botão
 * Usage p/ dado fresco). Retorna undefined sem token / falha / 401.
 */
export function fetchAccountUsage(force = false): Promise<ApiUsage | undefined> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) {
      dlog('usage-api', 'sem accessToken OAuth em ~/.claude/.credentials.json');
      cache = { at: Date.now(), data: undefined };
      resolve(undefined);
      return;
    }
    const done = (data?: ApiUsage) => {
      cache = { at: Date.now(), data };
      resolve(data);
    };
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              done(parseUsage(JSON.parse(body)));
            } catch (e) {
              dlog('usage-api', `200 mas JSON inválido: ${String(e)}`);
              done(undefined);
            }
          } else {
            dlog('usage-api', `HTTP ${res.statusCode}: ${body.slice(0, 200)}`); // 401/expirado/etc. -> fallback
            done(undefined);
          }
        });
      },
    );
    req.on('error', (e) => {
      dlog('usage-api', `erro de rede: ${String((e as Error)?.message || e)}`);
      done(undefined);
    });
    req.on('timeout', () => {
      dlog('usage-api', 'timeout (8s)');
      req.destroy();
      done(undefined);
    });
    req.end();
  });
}
