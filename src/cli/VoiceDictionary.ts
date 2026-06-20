// Dicionário de ditado POR LOGIN (conta Claude). Guarda termos a reconhecer/
// preservar e substituições "ouvido → escrito". Usado em dois pontos:
//   1. STT ao vivo: vira o header x-config-keyterms (Deepgram Nova-3 prioriza
//      esses termos no reconhecimento).
//   2. Pós-ditado: aplica as substituições ao texto e orienta o corretor Haiku
//      a PRESERVAR os termos (não "corrigir" nomes próprios/jargão).
// Arquivo: ~/.claude/tootega/voice-dictionary/<conta>.json (conta = e-mail slug).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchAuthStatus } from './AuthStatus';
import { log } from '../util/logger';

const DIR = path.join(os.homedir(), '.claude', 'tootega', 'voice-dictionary');
const VERSION = 1;
const MAX_TERMS = 200; // teto p/ não estourar o header de keyterms
const MAX_KEYTERMS_CHARS = 2000;

export interface Replacement {
  from: string; // como costuma ser ouvido/transcrito
  to: string; // como deve ficar escrito
}
export interface VoiceDict {
  terms: string[];
  replacements: Replacement[];
}

const EMPTY: VoiceDict = { terms: [], replacements: [] };

/** Slug seguro p/ nome de arquivo a partir do e-mail da conta (ou 'default'). */
export function accountSlug(email?: string): string {
  const s = (email || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  return s || 'default';
}

// Resolve a conta logada UMA vez (spawn do CLI é lento); cache até login/logout.
let keyPromise: Promise<string> | undefined;
export function resolveAccountKey(claudePath: string): Promise<string> {
  if (!keyPromise) {
    keyPromise = fetchAuthStatus(claudePath)
      .then((a) => accountSlug(a.email))
      .catch(() => 'default');
  }
  return keyPromise;
}
/** Invalida o cache da conta (chamar em login/logout). */
export function resetAccountKey(): void {
  keyPromise = undefined;
}

function fileFor(accountKey: string): string {
  const safe = accountKey.replace(/[^a-z0-9._-]+/gi, '_') || 'default';
  return path.join(DIR, `${safe}.json`);
}

/** Lê o dicionário da conta (vazio se ausente/corrompido). Tolerante. */
export function loadDictionary(accountKey: string): VoiceDict {
  let raw: string;
  try {
    raw = fs.readFileSync(fileFor(accountKey), 'utf8');
  } catch {
    // Legado: entradas salvas antes da chave estabilizar (em 'default'). Não perde.
    if (accountKey !== 'default') {
      try {
        raw = fs.readFileSync(fileFor('default'), 'utf8');
      } catch {
        return { ...EMPTY };
      }
    } else {
      return { ...EMPTY };
    }
  }
  try {
    const o = JSON.parse(raw);
    return {
      terms: Array.isArray(o?.terms) ? o.terms.filter((t: unknown) => typeof t === 'string' && t.trim()) : [],
      replacements: Array.isArray(o?.replacements)
        ? o.replacements
            .filter((r: any) => r && typeof r.from === 'string' && typeof r.to === 'string' && r.from.trim())
            .map((r: any) => ({ from: r.from, to: r.to }))
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Grava o dicionário da conta (atômico). Normaliza/dedupe os termos. */
export function saveDictionary(accountKey: string, dict: VoiceDict): void {
  const terms = dedupe((dict.terms ?? []).map((t) => t.trim()).filter(Boolean)).slice(0, MAX_TERMS);
  const replacements = (dict.replacements ?? [])
    .map((r) => ({ from: (r.from ?? '').trim(), to: (r.to ?? '').trim() }))
    .filter((r) => r.from);
  const dst = fileFor(accountKey);
  const tmp = `${dst}.tmp`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, terms, replacements }, null, 2));
    fs.renameSync(tmp, dst);
  } catch (e) {
    log(`voice-dict save fail (${accountKey}): ${String(e)}`);
  }
}

/** String de keyterms p/ o header do STT: termos do dicionário + extras (projeto). */
export function buildKeyterms(dict: VoiceDict, extra?: string): string {
  const all = dedupe([...(extra ? [extra] : []), ...dict.terms.map((t) => t.trim())].filter(Boolean));
  let out = '';
  for (const t of all) {
    const next = out ? `${out},${t}` : t;
    if (next.length > MAX_KEYTERMS_CHARS) break;
    out = next;
  }
  return out;
}

/** Aplica as substituições "ouvido → escrito" ao texto (case-insensitive, por palavra). */
export function applyReplacements(text: string, dict: VoiceDict): string {
  if (!text || !dict.replacements.length) return text;
  let out = text;
  for (const r of dict.replacements) {
    if (!r.from) continue;
    try {
      // Limite por não-letra (unicode), preservando o caso do alvo escrito.
      const re = new RegExp(`(?<!\\p{L})${escapeRe(r.from)}(?!\\p{L})`, 'giu');
      out = out.replace(re, r.to);
    } catch {
      /* regex inválida (raro): ignora a regra */
    }
  }
  return out;
}

/** Trecho de instrução p/ o corretor Haiku preservar termos e aplicar correções. */
export function correctorHints(dict: VoiceDict): string | undefined {
  const parts: string[] = [];
  if (dict.terms.length) {
    parts.push(`Preserve EXATAMENTE estes termos (nomes/jargão), sem alterar grafia: ${dict.terms.join(', ')}.`);
  }
  if (dict.replacements.length) {
    const map = dict.replacements.map((r) => `"${r.from}" → "${r.to}"`).join('; ');
    parts.push(`Aplique estas substituições quando aparecerem: ${map}.`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

function dedupe(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    const k = x.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
