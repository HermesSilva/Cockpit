// Dictation dictionary PER LOGIN (Claude account). Holds terms to recognize/
// preserve and "heard → written" replacements. Used in two places:
//   1. Live STT: becomes the x-config-keyterms header (Deepgram Nova-3 prioritizes
//      these terms during recognition).
//   2. Post-dictation: applies the replacements to the text and steers the Haiku corrector
//      to PRESERVE the terms (not to "fix" proper nouns/jargon).
// File: ~/.claude/tootega/voice-dictionary/<account>.json (account = e-mail slug).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetchAuthStatus } from './AuthStatus';
import { log } from '../util/logger';

// PER-MACHINE dictionaries (OS login), not per Claude account: a single file
// that applies to everything for this machine user. Includes dictation
// terms/replacements and the spell-checker words.
const DIR = path.join(os.homedir(), '.claude', 'tootega');
const LEGACY_DIR = path.join(DIR, 'voice-dictionary'); // antigo: por conta
const FILE = path.join(DIR, 'dictionaries.json');
const VERSION = 2;
const MAX_TERMS = 200; // cap so the keyterms header doesn't blow up
const MAX_KEYTERMS_CHARS = 2000;

export interface Replacement {
  from: string; // how it is usually heard/transcribed
  to: string; // how it should be written
}
export interface VoiceDict {
  terms: string[];
  replacements: Replacement[];
  spellWords?: string[]; // spell-checker dictionary (added/ignored words)
}

const EMPTY: VoiceDict = { terms: [], replacements: [], spellWords: [] };

/** Filename-safe slug from the account e-mail (or 'default'). */
export function accountSlug(email?: string): string {
  const s = (email || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
  return s || 'default';
}

// Resolves the logged-in account ONCE (the CLI spawn is slow); cached until login/logout.
let keyPromise: Promise<string> | undefined;
export function resolveAccountKey(claudePath: string): Promise<string> {
  if (!keyPromise) {
    keyPromise = fetchAuthStatus(claudePath)
      .then((a) => accountSlug(a.email))
      .catch(() => 'default');
  }
  return keyPromise;
}
/** Invalidates the account cache (call on login/logout). */
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

// Migration: merges the legacy per-account dictionaries into one (once).
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
        /* ignores a corrupted file */
      }
    }
  } catch {
    /* no legacy dir */
  }
  return merged;
}

/** Reads the machine dictionary (empty when missing/corrupted). Tolerant. */
export function loadDictionary(): VoiceDict {
  try {
    return parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return migrateLegacy(); // 1ª vez: aproveita o legado por-conta
  }
}

/** Writes the machine dictionary (atomic). Normalizes/dedupes. */
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

/**
 * Keyterms string for the STT header. Order = PRIORITY: the user's dictionary
 * terms first (hand-curated, more valuable), then the extras harvested
 * from the workspace (project name, deps, glossary). The char budget cuts the
 * overflow — so what the user defined is never dropped in favor of the automatic ones.
 * `extras` accepts a single string (compat) or a list.
 */
export function buildKeyterms(dict: VoiceDict, extras?: string | string[]): string {
  const extraList = extras == null ? [] : Array.isArray(extras) ? extras : [extras];
  const all = dedupe([...dict.terms.map((t) => t.trim()), ...extraList.map((e) => e.trim())].filter(Boolean));
  let out = '';
  for (const t of all) {
    const next = out ? `${out},${t}` : t;
    if (next.length > MAX_KEYTERMS_CHARS) break;
    out = next;
  }
  return out;
}

/** Applies the "heard → written" replacements to the text (case-insensitive, per word). */
export function applyReplacements(text: string, dict: VoiceDict): string {
  if (!text || !dict.replacements.length) return text;
  let out = text;
  for (const r of dict.replacements) {
    if (!r.from) continue;
    try {
      // Bounded by a non-letter (unicode), preserving the case of the written target.
      const re = new RegExp(`(?<!\\p{L})${escapeRe(r.from)}(?!\\p{L})`, 'giu');
      out = out.replace(re, r.to);
    } catch {
      /* invalid regex (rare): the rule is ignored */
    }
  }
  return out;
}

/** Instruction snippet for the Haiku corrector to preserve terms and apply corrections. */
export function correctorHints(dict: VoiceDict): string | undefined {
  const parts: string[] = [];
  if (dict.terms.length) {
    parts.push(`Preserve these terms EXACTLY (names/jargon), without changing their spelling: ${dict.terms.join(', ')}.`);
  }
  if (dict.replacements.length) {
    const map = dict.replacements.map((r) => `"${r.from}" → "${r.to}"`).join('; ');
    parts.push(`Apply these replacements whenever they appear: ${map}.`);
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
