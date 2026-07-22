// Model prices from Anthropic's pricing docs.
// There is NO price endpoint in the API — the price only lives in the docs. We fetch the
// pricing page markdown once a day (cached in globalStorage) and parse the
// "Model pricing" table (one row per model). It is a READ of a public doc, without auth and
// without token spend — it is not part of the agent loop.
//
// The table looks like:
//   | Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
//   | Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
// The name ("Claude Opus 4.8") is normalized to the API id ("claude-opus-4-8").
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../util/logger';

const PRICING_HOST = 'platform.claude.com';
const PRICING_PATH = '/docs/en/about-claude/pricing.md';
const CACHE_FILE = 'model-pricing.json';
const MAX_AGE_MS = 24 * 3600_000; // rebusca 1x/dia

export interface PriceInfo {
  inMTok: number; // USD por 1M tokens de entrada
  outMTok: number; // USD por 1M tokens de saída
}
export type PricingMap = Record<string, PriceInfo>;

interface PricingCache {
  fetchedAt: number; // epoch ms
  models: PricingMap;
}

/**
 * Returns the price map, using the on-disk cache when fresh (<24h); otherwise fetches
 * the docs, saves and returns. Never throws: on a network/parse failure it returns the old
 * cache (if any) or {}.
 */
export async function ensurePricing(cacheDir: string): Promise<PricingMap> {
  const cached = readCache(cacheDir);
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
    return cached.models;
  }
  const fresh = await fetchPricingDocs();
  if (Object.keys(fresh).length > 0) {
    writeCache(cacheDir, { fetchedAt: Date.now(), models: fresh });
    return fresh;
  }
  // Fetch failed: keeps whatever we have (even if stale) so prices don't vanish from the UI.
  return cached?.models ?? {};
}

/** "Claude Opus 4.8" -> "claude-opus-4-8". undefined when the pattern doesn't match. */
export function nameToId(name: string): string | undefined {
  // Ignores markdown links and text after the name ("... starting September 1, 2026").
  const stripped = name.replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
  const m = stripped.match(/^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)/i);
  if (!m) return undefined;
  const family = m[1].toLowerCase();
  const version = m[2].replace(/\./g, '-');
  return `claude-${family}-${version}`;
}

/** Extracts the first dollar value from a cell ("$6.25 / MTok" -> 6.25). */
function parseUsd(cell: string): number | undefined {
  const m = cell.match(/\$\s*([\d.]+)/);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

/** Parses the docs markdown and returns id -> {inMTok, outMTok}. */
export function parsePricingMarkdown(md: string): PricingMap {
  const out: PricingMap = {};
  // Cuts the "## Model pricing" section up to the next level-2 heading.
  const start = md.search(/^##\s+Model pricing/im);
  const section = start >= 0 ? md.slice(start) : md;
  const end = section.search(/^##\s+(?!Model pricing)/im);
  const block = end > 0 ? section.slice(0, end) : section;

  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // ['', Model, Base Input, 5m, 1h, Cache Hits, Output, '']
    if (cells.length < 7) continue;
    const name = cells[1];
    if (!name || /^-+$/.test(name) || /^model$/i.test(name)) continue; // separador/cabeçalho
    const id = nameToId(name);
    if (!id || out[id]) continue; // 1ª ocorrência vence (ex.: preço introdutório atual)
    const inMTok = parseUsd(cells[2]); // Base Input Tokens
    const outMTok = parseUsd(cells[cells.length - 2]); // Output Tokens (última antes do '')
    if (inMTok === undefined || outMTok === undefined) continue;
    out[id] = { inMTok, outMTok };
  }
  return out;
}

function fetchPricingDocs(): Promise<PricingMap> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: PRICING_HOST,
        path: PRICING_PATH,
        method: 'GET',
        headers: { accept: 'text/markdown, text/plain, */*' },
        timeout: 8000,
      },
      (res) => {
        // Follows one simple redirect when present (same host).
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchRedirect(res.headers.location));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(parsePricingMarkdown(body));
            } catch (e) {
              log(`[pricing] parse fail: ${String(e)}`);
              resolve({});
            }
          } else {
            log(`[pricing] http ${res.statusCode}`);
            resolve({});
          }
        });
      },
    );
    req.on('error', (e) => {
      log(`[pricing] req error: ${String(e)}`);
      resolve({});
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({});
    });
    req.end();
  });
}

function fetchRedirect(location: string): Promise<PricingMap> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(location, `https://${PRICING_HOST}`);
    } catch {
      resolve({});
      return;
    }
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'GET', timeout: 8000 },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(res.statusCode && res.statusCode < 300 ? parsePricingMarkdown(body) : {});
          } catch {
            resolve({});
          }
        });
      },
    );
    req.on('error', () => resolve({}));
    req.on('timeout', () => {
      req.destroy();
      resolve({});
    });
    req.end();
  });
}

function readCache(dir: string): PricingCache | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, CACHE_FILE), 'utf8');
    const o = JSON.parse(raw);
    if (o && typeof o.fetchedAt === 'number' && o.models) return o as PricingCache;
  } catch {
    /* no cache */
  }
  return undefined;
}

function writeCache(dir: string, data: PricingCache): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, CACHE_FILE), JSON.stringify(data), 'utf8');
  } catch (e) {
    log(`[pricing] cache write fail: ${String(e)}`);
  }
}
