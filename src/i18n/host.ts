// Locale resolution on the host side (notifications via vscode.l10n).
import * as vscode from 'vscode';

export type LocaleId = 'pt-BR' | 'en';

export function resolveLocale(): LocaleId {
  const cfg = vscode.workspace.getConfiguration('tootega').get<string>('language', 'auto');
  const raw = cfg && cfg !== 'auto' ? cfg : vscode.env.language;
  return raw?.toLowerCase().startsWith('pt') ? 'pt-BR' : 'en';
}
