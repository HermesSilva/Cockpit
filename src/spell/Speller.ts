// Corretor ortográfico bilíngue (PT-BR + EN) no HOST, via hunspell-asm (WASM).
// Roda no host (Node) p/ evitar WASM/CSP/worker no webview e não travar a UI.
// Dicionários ficam em arquivos de dados (dict/*.aff|*.dic), carregados em
// segundo plano; o hunspell indexa e aplica os affixes sob demanda (o pt-br
// completo tem ~21M formas — impossível pré-expandir).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../util/logger';

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

  constructor(
    private dictDir: string,
    initialUserWords: string[] = [],
  ) {
    for (const w of initialUserWords) this.userWords.add(w);
  }

  /** Carrega o WASM + dicionários em segundo plano (idempotente). */
  ensure(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = this.load();
    return this.loading;
  }

  private async load(): Promise<void> {
    try {
      const t0 = Date.now();
      // import dinâmico: não paga o custo até a 1ª checagem.
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
      log(`[spell] dicionários carregados em ${Date.now() - t0}ms`);
    } catch (e) {
      log(`[spell] falha ao carregar: ${String(e)}`);
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private known(word: string): boolean {
    return this.userWords.has(word) || this.userWords.has(word.toLowerCase());
  }

  /** Subconjunto de `words` com erro (reprovado em PT e EN). */
  check(words: string[]): string[] {
    if (!this.ready || !this.en || !this.pt) return [];
    const bad: string[] = [];
    for (const w of words) {
      if (this.known(w)) continue;
      if (!this.en.spell(w) && !this.pt.spell(w)) bad.push(w);
    }
    return bad;
  }

  /** Sugestões agrupadas por idioma (até `max` cada). */
  suggest(word: string, max = 7): SpellSuggestions {
    if (!this.ready || !this.en || !this.pt) return { pt: [], en: [] };
    return {
      pt: this.pt.suggest(word).slice(0, max),
      en: this.en.suggest(word).slice(0, max),
    };
  }

  addWord(word: string): void {
    const w = word.trim();
    if (w) this.userWords.add(w);
  }

  /** Substitui o dicionário do usuário (edição no modal). */
  setUserDict(words: string[]): void {
    this.userWords = new Set(words.map((w) => w.trim()).filter(Boolean));
  }

  userDict(): string[] {
    return [...this.userWords];
  }
}
