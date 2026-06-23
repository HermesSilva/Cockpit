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

// Dicionários POR MÁQUINA (login do SO), não por conta Claude: um único arquivo
// que vale para tudo deste usuário da máquina. Inclui termos/substituições do
// ditado e as palavras do corretor.
const DIR = path.join(os.homedir(), '.claude', 'tootega');
const LEGACY_DIR = path.join(DIR, 'voice-dictionary'); // antigo: por conta
const FILE = path.join(DIR, 'dictionaries.json');
const VERSION = 2;
const MAX_TERMS = 200; // teto p/ não estourar o header de keyterms
const MAX_KEYTERMS_CHARS = 2000;

export interface Replacement {
  from: string; // como costuma ser ouvido/transcrito
  to: string; // como deve ficar escrito
}
export interface VoiceDict {
  terms: string[];
  replacements: Replacement[];
  spellWords?: string[]; // dicionário do corretor (palavras adicionadas/ignoradas)
}

const EMPTY: VoiceDict = { terms: [], replacements: [], spellWords: [] };

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

function parse(raw: string): VoiceDict {
  const o = JSON.parse(raw);
  return {
    terms: Array.isArray(o?.terms) ? o.terms.filter((t: unknown) => typeof t === 'string' && t.trim()) : [],
    replacements: Array.isArray(o?.replacements)
      ? o.replacements
          .filter((r: any) => r && typeof r.from === 'string' && typeof r.to === 'string' && r.from.trim())
          .map((r: any) => ({ from: r.from, to: r.to }))
      : [],
    spellWords: Array.isArray(o?.spellWords)
      ? o.spellWords.filter((w: unknown) => typeof w === 'string' && w.trim())
      : [],
  };
}

// Migração: junta os dicionários por-conta legados num só (uma vez).
function migrateLegacy(): VoiceDict {
  const merged: VoiceDict = { terms: [], replacements: [], spellWords: [] };
  try {
    for (const f of fs.readdirSync(LEGACY_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const d = parse(fs.readFileSync(path.join(LEGACY_DIR, f), 'utf8'));
        merged.terms.push(...d.terms);
        merged.replacements.push(...d.replacements);
        merged.spellWords!.push(...(d.spellWords ?? []));
      } catch {
        /* ignora arquivo corrompido */
      }
    }
  } catch {
    /* sem dir legado */
  }
  return merged;
}

/** Lê o dicionário da máquina (vazio se ausente/corrompido). Tolerante. */
export function loadDictionary(): VoiceDict {
  try {
    return parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return migrateLegacy(); // 1ª vez: aproveita o legado por-conta
  }
}

/** Grava o dicionário da máquina (atômico). Normaliza/dedupe. */
export function saveDictionary(dict: VoiceDict): void {
  const terms = dedupe((dict.terms ?? []).map((t) => t.trim()).filter(Boolean)).slice(0, MAX_TERMS);
  const replacements = (dict.replacements ?? [])
    .map((r) => ({ from: (r.from ?? '').trim(), to: (r.to ?? '').trim() }))
    .filter((r) => r.from);
  const spellWords = dedupe((dict.spellWords ?? []).map((w) => w.trim()).filter(Boolean));
  const tmp = `${FILE}.tmp`;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, terms, replacements, spellWords }, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    log(`dict save fail: ${String(e)}`);
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
