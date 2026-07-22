// Researches, via AI, metadata for unknown slash commands: category (for
// grouping), a short hint and a detail — in the Cockpit's language. The result is cached in a
// GLOBAL file under ~/.claude/tootega/ (serves any project). On load,
// only the commands missing from the cache are researched. Uses the AiClient helper (direct
// API, ~1-2s) — it used to be a CLI one-shot (~5s of cold start).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ask } from './AiClient';
import { log } from '../util/logger';

export type CmdCategory =
  | 'session'
  | 'context'
  | 'config'
  | 'tools'
  | 'account'
  | 'info'
  | 'plugin'
  | 'other';

const CATEGORIES: CmdCategory[] = [
  'session',
  'context',
  'config',
  'tools',
  'account',
  'info',
  'plugin',
  'other',
];

export interface CmdInfo {
  category: CmdCategory;
  hint: string; // curto (<=140), no idioma do locale
  detail?: string; // 1 frase
  group?: string; // nome do plugin/ferramenta de terceiro (agrupa junto)
  researchedAt: string; // ISO
}

interface Cache {
  version: number;
  locales: Record<string, Record<string, CmdInfo>>;
}

// Built-ins already covered by the webview's static catalog — they don't spend AI.
const BUILTIN = new Set([
  'clear', 'compact', 'context', 'memory', 'resume', 'model', 'config', 'permissions',
  'review', 'init', 'mcp', 'agents', 'hooks', 'login', 'logout', 'cost', 'usage', 'status',
  'help', 'doctor',
]);

const CACHE_FILE = path.join(os.homedir(), '.claude', 'tootega', 'slash-commands.json');

function loadCache(): Cache {
  try {
    const o = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (o && typeof o === 'object' && o.locales) return o as Cache;
  } catch {
    /* missing/corrupted file: starts empty */
  }
  return { version: 1, locales: {} };
}

function saveCache(c: Cache): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2));
  } catch (e) {
    log(`slash cache save fail: ${String(e)}`);
  }
}

function langName(locale: string): string {
  return /^pt/i.test(locale) ? 'Brazilian Portuguese (pt-BR)' : 'international English';
}

let inFlight = false;

/**
 * Returns the cmd->CmdInfo map for the locale (cache + freshly researched). Researches via
 * AI only the commands missing from the cache and outside the built-in catalog. Best-effort:
 * an AI failure keeps the current cache.
 */
export async function researchCommands(opts: {
  commands: string[];
  locale: string;
  onResearchStart?: () => void; // chamado só quando vai mesmo consultar a IA
}): Promise<Record<string, CmdInfo>> {
  const { commands, locale, onResearchStart } = opts;
  const cache = loadCache();
  const known = cache.locales[locale] ?? {};
  const names = commands.map((c) => c.replace(/^\//, '').trim()).filter(Boolean);
  const missing = names.filter((n) => !known[n] && !BUILTIN.has(n));
  if (missing.length === 0 || inFlight) return known;

  inFlight = true;
  onResearchStart?.();
  try {
    const researched = await askAI(missing, locale);
    const now = new Date().toISOString();
    for (const [name, info] of Object.entries(researched)) {
      known[name] = { ...info, researchedAt: now };
    }
    cache.locales[locale] = known;
    saveCache(cache);
    log(`slash research: +${Object.keys(researched).length}/${missing.length} (${locale})`);
  } catch (e) {
    log(`slash research fail: ${String(e)}`);
  } finally {
    inFlight = false;
  }
  return known;
}

type AiInfo = { category: CmdCategory; hint: string; detail?: string; group?: string };

async function askAI(missing: string[], locale: string): Promise<Record<string, AiInfo>> {
  const text = await ask({ prompt: buildPrompt(missing, locale), maxTokens: 2048 });
  if (!text) throw new Error('no ai output');
  return parseAI(text, missing);
}

function buildPrompt(missing: string[], locale: string): string {
  return [
    'You document Claude Code slash commands for a GUI command palette.',
    'For each command below, classify it and write help text.',
    'Reply with MINIFIED JSON ONLY (no markdown, no prose, no code fence). Shape:',
    `{"<cmd>":{"category":"<one of: ${CATEGORIES.join('|')}>","group":"<plugin name or omit>","hint":"<<=90 chars>","detail":"<one full sentence>"}}`,
    `If a command belongs to a third-party plugin/extension/tool, set "group" to that tool's short lowercase name (commands of the same tool MUST share the same group), and set category to "plugin". Omit "group" for first-party Claude Code commands.`,
    `Write "hint" and "detail" in ${langName(locale)}.`,
    `Commands (no leading slash): ${missing.join(', ')}`,
  ].join('\n');
}

function parseAI(text: string, missing: string[]): Record<string, AiInfo> {
  // The helper returns the model's text directly (the JSON we asked for).
  const raw = JSON.parse(extractJson(text)) as Record<string, unknown>;
  const out: Record<string, AiInfo> = {};
  for (const name of missing) {
    const v = (raw[name] ?? raw[`/${name}`]) as
      | { category?: unknown; hint?: unknown; detail?: unknown; group?: unknown }
      | undefined;
    if (!v || typeof v.hint !== 'string' || !v.hint.trim()) continue;
    const cat = (CATEGORIES as string[]).includes(v.category as string)
      ? (v.category as CmdCategory)
      : 'other';
    const group =
      typeof v.group === 'string' && v.group.trim()
        ? v.group.trim().toLowerCase().slice(0, 40)
        : undefined;
    out[name] = {
      category: group ? 'plugin' : cat,
      hint: v.hint.slice(0, 140),
      detail: typeof v.detail === 'string' ? v.detail.slice(0, 300) : undefined,
      group,
    };
  }
  return out;
}

function extractJson(s: string): string {
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j < 0 || j < i) throw new Error('no json in AI output');
  return s.slice(i, j + 1);
}
