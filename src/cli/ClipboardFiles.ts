// Lê os caminhos de arquivos copiados no Explorer (CF_HDROP) — indisponível no
// webview sandbox (File.path ausente). Windows via PowerShell Get-Clipboard.
import { spawnSync } from 'node:child_process';

export function readClipboardFiles(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Força UTF-8 na saída (evita corrupção de acentos por code page).
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }',
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (res.status !== 0) return [];
    return (res.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim().normalize('NFC')) // normaliza acentos (NFC)
      .filter(Boolean);
  } catch {
    return [];
  }
}
