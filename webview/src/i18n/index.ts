// Camada de i18n do webview. Troca de locale em runtime, interpolação {0}, {1}…
import { en, type Strings } from './en';
import { ptBR } from './pt-br';

export type LocaleId = 'en' | 'pt-BR';

const catalogs: Record<LocaleId, Strings> = {
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
