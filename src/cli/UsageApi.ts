// REAL account usage via the Claude OAuth endpoint (the same source as the CLI's /usage).
// GET https://api.anthropic.com/api/oauth/usage — read-only, spends NO tokens.
// Uses the OAuth accessToken from ~/.claude/.credentials.json (read-only; never writes
// nor logs credentials). Short in-memory cache so it isn't repeated on every refresh.
//
// Resilience matters more than freshness here: a single timeout/5xx used to drop the whole
// panel back to the local $ estimate, which is a much worse answer than a real % read a few
// minutes ago. So a failed fetch retries once and then falls back to the last good reading
// while it is still meaningful (STALE_OK_MS).
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
  ageMs?: number; // >0 when this is a reused reading (the live fetch failed)
}

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const TTL_MS = 30_000; // positive cache
const FAIL_TTL_MS = 5_000; // negative cache — short, so a blip doesn't stick for half a minute
const STALE_OK_MS = 15 * 60_000; // last good reading still usable while the API is unreachable
const RETRY_DELAY_MS = 700;

let cache: { at: number; data?: ApiUsage } | undefined;
let lastGood: { at: number; data: ApiUsage } | undefined;
let lastError: string | undefined;

/** Why the last live fetch failed, and how old the reading in hand is (Usage modal/diagnostics). */
export function usageDiagnostics(): { lastError?: string; lastGoodAgeMs?: number } {
  return { lastError, lastGoodAgeMs: lastGood ? Date.now() - lastGood.at : undefined };
}

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

type Attempt =
  | { ok: true; data: ApiUsage }
  | { ok: false; reason: string; retry: boolean };

/** One GET. `retry` tells whether the failure is transient (network/timeout/429/5xx). */
function requestUsage(token: string): Promise<Attempt> {
  return new Promise((resolve) => {
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
          const code = res.statusCode ?? 0;
          if (code >= 200 && code < 300) {
            try {
              resolve({ ok: true, data: parseUsage(JSON.parse(body)) });
            } catch (e) {
              resolve({ ok: false, reason: `bad JSON: ${String(e)}`, retry: false });
            }
            return;
          }
          // 401 = token expired/revoked; the CLI refreshes it — retrying now won't help.
          resolve({
            ok: false,
            reason: `HTTP ${code}`,
            retry: code === 429 || code >= 500,
          });
        });
      },
    );
    req.on('error', (e) =>
      resolve({ ok: false, reason: `network: ${String((e as Error)?.message || e)}`, retry: true }),
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout (8s)', retry: true });
    });
    req.end();
  });
}

/** Last successful reading, while it is recent enough to still be worth showing. */
function staleFallback(): ApiUsage | undefined {
  if (!lastGood) return undefined;
  const age = Date.now() - lastGood.at;
  if (age > STALE_OK_MS) return undefined;
  return { ...lastGood.data, ageMs: age };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetches the real account usage. 30s cache (use force=true on the Usage button
 * click for fresh data). On failure retries once (transient causes only) and then reuses the
 * last good reading; returns undefined only when there is no usable real data at all.
 */
export async function fetchAccountUsage(force = false): Promise<ApiUsage | undefined> {
  if (cache && !force) {
    const age = Date.now() - cache.at;
    if (age < (cache.data ? TTL_MS : FAIL_TTL_MS)) return cache.data ?? staleFallback();
  }
  const token = readToken();
  if (!token) {
    lastError = 'no OAuth accessToken in ~/.claude/.credentials.json';
    dlog('usage-api', lastError);
    cache = { at: Date.now(), data: undefined };
    return staleFallback();
  }
  let last: Attempt = { ok: false, reason: 'not attempted', retry: false };
  for (let i = 0; i < 2; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    last = await requestUsage(token);
    if (last.ok || !last.retry) break;
    dlog('usage-api', `attempt ${i + 1} failed (${last.reason})`);
  }
  if (last.ok) {
    lastError = undefined;
    lastGood = { at: Date.now(), data: last.data };
    cache = { at: Date.now(), data: last.data };
    return last.data;
  }
  lastError = last.reason;
  dlog('usage-api', `giving up: ${last.reason}`);
  cache = { at: Date.now(), data: undefined };
  return staleFallback();
}

/** Test helper: drops every cached state. */
export function resetUsageCache(): void {
  cache = undefined;
  lastGood = undefined;
  lastError = undefined;
}
