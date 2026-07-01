// Preço dos modelos a partir das docs de pricing da Anthropic.
// NÃO há endpoint de preço na API — o preço só vive nas docs. Buscamos o markdown
// da página de pricing 1x/dia (cache em globalStorage) e parseamos a tabela
// "Model pricing" (uma linha por modelo). É LEITURA de doc pública, sem auth e
// sem gasto de token — não faz parte do loop do agente.
//
// A tabela tem a forma:
//   | Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
//   | Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
// O nome ("Claude Opus 4.8") é normalizado p/ o id da API ("claude-opus-4-8").
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
 * Devolve o mapa de preços, usando cache em disco se fresco (<24h); senão busca
 * as docs, salva e devolve. Nunca lança: em falha de rede/parse devolve o cache
 * antigo (se houver) ou {}.
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
  // Falha na busca: mantém o que tiver (mesmo velho) p/ não apagar preço da UI.
  return cached?.models ?? {};
}

/** "Claude Opus 4.8" -> "claude-opus-4-8". undefined se não casar o padrão. */
export function nameToId(name: string): string | undefined {
  // Ignora links markdown e texto após o nome ("... starting September 1, 2026").
  const stripped = name.replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
  const m = stripped.match(/^Claude\s+([A-Za-z]+)\s+(\d+(?:\.\d+)?)/i);
  if (!m) return undefined;
  const family = m[1].toLowerCase();
  const version = m[2].replace(/\./g, '-');
  return `claude-${family}-${version}`;
}

/** Extrai o primeiro valor em dólar de uma célula ("$6.25 / MTok" -> 6.25). */
function parseUsd(cell: string): number | undefined {
  const m = cell.match(/\$\s*([\d.]+)/);
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

/** Parseia o markdown das docs e devolve id -> {inMTok, outMTok}. */
export function parsePricingMarkdown(md: string): PricingMap {
  const out: PricingMap = {};
  // Recorta a seção "## Model pricing" até o próximo cabeçalho de nível 2.
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
        // Segue 1 redirect simples se vier (mesmo host).
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
    /* sem cache */
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
