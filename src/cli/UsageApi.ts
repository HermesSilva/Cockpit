// Uso REAL da conta via endpoint OAuth do Claude (mesma fonte do /usage do CLI).
// GET https://api.anthropic.com/api/oauth/usage — read-only, NÃO gasta token.
// Usa o accessToken OAuth de ~/.claude/.credentials.json (só leitura; nunca grava
// nem registra credenciais). Cache curto em memória p/ não repetir a cada refresh.
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LimitWindow } from '../../shared/protocol';

export interface ApiUsage {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  sevenDaySonnet?: LimitWindow;
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

/** Janela da API ({utilization:0..100, resets_at}) -> LimitWindow (usedPct 0..1). */
function win(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object' || typeof w.utilization !== 'number') return undefined;
  const resetsAt = typeof w.resets_at === 'string' ? w.resets_at : undefined;
  return { usedPct: Math.max(0, Math.min(1, w.utilization / 100)), resetsAt };
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
              const j = JSON.parse(body);
              done({
                fiveHour: win(j.five_hour),
                sevenDay: win(j.seven_day),
                sevenDaySonnet: win(j.seven_day_sonnet),
              });
            } catch {
              done(undefined);
            }
          } else {
            done(undefined); // 401/expirado/etc. -> fallback
          }
        });
      },
    );
    req.on('error', () => done(undefined));
    req.on('timeout', () => {
      req.destroy();
      done(undefined);
    });
    req.end();
  });
}
