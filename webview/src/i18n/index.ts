// The webview's i18n layer. Runtime locale switching, interpolation {0}, {1}…
import { en, type Strings } from './en';
import { ptBR } from './pt-br';

export type LocaleId = 'en' | 'pt-BR';

// Catálogo parcial: chaves novas entram só em `en` e as demais localidades caem
// no fallback abaixo (`table[key] ?? en[key]`) em vez de travar o typecheck.
const catalogs: Record<LocaleId, Partial<Strings>> = {
  en,
  'pt-BR': ptBR,
};

export function normalizeLocale(raw: string | undefined): LocaleId {
  if (!raw) return 'en';
  return raw.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}

export function createTranslator(localeRaw: string | undefined) {
  const locale = normalizeLocale(localeRaw);
  const table = catalogs[locale];
  return function t(key: keyof Strings, ...args: (string | number)[]): string {
    let s: string = table[key] ?? en[key] ?? String(key);
    args.forEach((a, i) => {
      s = s.replace(new RegExp(`\\{${i}\\}`, 'g'), String(a));
    });
    return s;
  };
}

export type Translator = ReturnType<typeof createTranslator>;
