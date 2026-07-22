// REAL account usage via the Claude OAuth endpoint (the same source as the CLI's /usage).
// GET https://api.anthropic.com/api/oauth/usage — read-only, spends NO tokens.
// Uses the OAuth accessToken from ~/.claude/.credentials.json (read-only; never writes
// nor logs credentials). Short in-memory cache so it isn't repeated on every refresh.
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

/** OAuth accessToken (read-only). The server is the authority on validity. */
function readToken(): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const tok = o?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/** API window ({utilization|percent:0..100, resets_at}) -> LimitWindow (usedPct 0..1). */
function win(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  const pct = typeof w.utilization === 'number' ? w.utilization : w.percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined;
  const resetsAt = typeof w.resets_at === 'string' ? w.resets_at : undefined;
  return { usedPct: Math.max(0, Math.min(1, pct / 100)), resetsAt };
}

/**
 * Extracts the windows from the payload. Current format: a `limits[]` array with
 * `kind` = session | weekly_all | weekly_scoped, and `scope.model.display_name`
 * naming the model of the scoped window (it used to be fixed `seven_day_opus`/`_sonnet`).
 * Falls back to the legacy top-level fields when `limits[]` is absent.
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
    // Legacy: per-model weekly windows in fixed top-level fields.
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
 * Fetches the real account usage. 30s cache (use force=true on the Usage button
 * click for fresh data). Returns undefined with no token / on failure / on 401.
 */
export function fetchAccountUsage(force = false): Promise<ApiUsage | undefined> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) {
      dlog('usage-api', 'no OAuth accessToken in ~/.claude/.credentials.json');
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
              dlog('usage-api', `200 but invalid JSON: ${String(e)}`);
              done(undefined);
            }
          } else {
            dlog('usage-api', `HTTP ${res.statusCode}: ${body.slice(0, 200)}`); // 401/expired/etc. -> fallback
            done(undefined);
          }
        });
      },
    );
    req.on('error', (e) => {
      dlog('usage-api', `network error: ${String((e as Error)?.message || e)}`);
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
