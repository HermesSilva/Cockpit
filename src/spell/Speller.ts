// Bilingual spell-checker (PT-BR + EN) on the HOST, via hunspell-asm (WASM).
// Runs on the host (Node) to keep WASM/CSP/workers out of the webview and avoid freezing the UI.
// Dictionaries live in data files (dict/*.aff|*.dic), loaded in the
// background; hunspell indexes and applies the affixes on demand (the full pt-br
// has ~21M forms — impossible to pre-expand).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log, dlog } from '../util/logger';

// No real word is longer than this; bigger tokens are junk (URL glue, base64,
// hash) and risk blowing the hunspell WASM heap (access violation → the whole
// extension host dies, taking every webview with it). try/catch does NOT catch a
// native crash: the only defense is not handing pathological input to the WASM.
const MAX_SPELL_LEN = 64;
// Tokens with a control character (NUL..US, DEL) are invalid input for the WASM.
/** Token safe to hand to the WASM? Size cap + no control chars. */
function spellSafe(word: string): boolean {
  if (!word || word.length > MAX_SPELL_LEN) return false;
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    if (c < 32 || c === 127) return false;
  }
  return true;
}

interface Hunspell {
  spell(word: string): boolean;
  suggest(word: string): string[];
}
interface HunspellFactory {
  mountBuffer(buf: Uint8Array, name: string): string;
  create(affPath: string, dicPath: string): Hunspell;
}

export interface SpellSuggestions {
  pt: string[];
  en: string[];
}

export class Speller {
  private en?: Hunspell;
  private pt?: Hunspell;
  private loading?: Promise<void>;
  private ready = false;
  private userWords = new Set<string>();
  // Project technical terms (deps, glossary, dictation dictionary terms).
  // Treated as KNOWN — they are not errors — but NOT persisted in the user's
  // dict: they are derived from the workspace and recomputed every session.
  private projectWords = new Set<string>();

  constructor(
    private dictDir: string,
    initialUserWords: string[] = [],
  ) {
    for (const w of initialUserWords) this.userWords.add(w);
  }

  /** Loads the WASM + dictionaries in the background (idempotent). */
  ensure(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const t0 = Date.now();
      // dynamic import: doesn't pay the cost until the first check.
      const { loadModule } = (await import('hunspell-asm')) as {
        loadModule: () => Promise<HunspellFactory>;
      };
      const factory = await loadModule();
      const mount = (lang: string, base: string): Hunspell => {
        const aff = factory.mountBuffer(fs.readFileSync(path.join(this.dictDir, `${base}.aff`)), `${lang}.aff`);
        const dic = factory.mountBuffer(fs.readFileSync(path.join(this.dictDir, `${base}.dic`)), `${lang}.dic`);
        return factory.create(aff, dic);
      };
      this.en = mount('en', 'en');
      this.pt = mount('pt', 'pt-br');
      this.ready = true;
      log(`[spell] dictionaries loaded in ${Date.now() - t0}ms`);
    } catch (e) {
      log(`[spell] failed to load: ${String(e)}`);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private known(word: string): boolean {
    const lower = word.toLowerCase();
    return (
      this.userWords.has(word) ||
      this.userWords.has(lower) ||
      this.projectWords.has(word) ||
      this.projectWords.has(lower)
    );
  }

  /** Sets the project's technical terms (not persisted). Case-insensitive. */
  setProjectTerms(words: string[]): void {
    this.projectWords = new Set<string>();
    for (const w of words) {
      const t = w.trim();
      if (t) {
        this.projectWords.add(t);
        this.projectWords.add(t.toLowerCase());
      }
    }
  }

  /** Subset of `words` that is wrong (rejected in both PT and EN). */
  check(words: string[]): string[] {
    if (!this.ready || !this.en || !this.pt) return [];
    const bad: string[] = [];
    for (const w of words) {
      if (this.known(w)) continue;
      // Pathological token: treated as correct (not flagged) instead of risking the WASM.
      if (!spellSafe(w)) {
        dlog('spell', `token skipped (unsafe for WASM): len=${w.length}`);
        continue;
      }
      if (!this.en.spell(w) && !this.pt.spell(w)) bad.push(w);
    }
    return bad;
  }

  /** Suggestions grouped by language (up to `max` each). */
  suggest(word: string, max = 7): SpellSuggestions {
    if (!this.ready || !this.en || !this.pt) return { pt: [], en: [] };
    if (!spellSafe(word)) {
      dlog('spell', `suggest skipped (unsafe for WASM): len=${word.length}`);
      return { pt: [], en: [] };
    }
    return {
      pt: this.pt.suggest(word).slice(0, max),
      en: this.en.suggest(word).slice(0, max),
    };
  }

  addWord(word: string): void {
    const w = word.trim();
    if (w) this.userWords.add(w);
  }

  /** Replaces the user dictionary (edited in the modal). */
  setUserDict(words: string[]): void {
    this.userWords = new Set(words.map((w) => w.trim()).filter(Boolean));
  }

  userDict(): string[] {
    return [...this.userWords];
  }
}
