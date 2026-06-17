// Lê os caminhos de arquivos copiados no gerenciador de arquivos do SO — info que
// o webview sandbox não expõe (File.path ausente). Por plataforma:
//   win32  : PowerShell Get-Clipboard -Format FileDropList (CF_HDROP)
//   darwin : AppleScript (the clipboard as «class furl») → POSIX path
//   linux  : text/uri-list via wl-paste (Wayland) ou xclip (X11) → file:// decodificado
// Best-effort: ferramenta ausente / sem arquivos → [].
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function readClipboardFiles(): string[] {
  try {
    switch (process.platform) {
      case 'win32':
        return readWindows();
      case 'darwin':
        return readMac();
      default:
        return readLinux();
    }
  } catch {
    return [];
  }
}

function readWindows(): string[] {
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
}

function readMac(): string[] {
  // Finder copia arquivos como file-url. AppleScript devolve o POSIX path.
  const res = spawnSync(
    'osascript',
    ['-e', 'POSIX path of (the clipboard as «class furl»)'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (res.status !== 0) return [];
  const p = (res.stdout || '').trim();
  return p ? [p.normalize('NFC')] : []; // coerção «class furl» rende 1 arquivo
}

function readLinux(): string[] {
  // Gerenciadores de arquivo expõem a seleção como text/uri-list (file://...).
  // Tenta Wayland (wl-paste) e depois X11 (xclip); decodifica file:// → caminho.
  const tries: Array<[string, string[]]> = [
    ['wl-paste', ['-t', 'text/uri-list']],
    ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-o']],
  ];
  for (const [cmd, args] of tries) {
    const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (res.status !== 0 || !res.stdout) continue;
    const paths = res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith('file://'))
      .map(uriToPath)
      .filter((p): p is string => !!p);
    if (paths.length) return paths;
  }
  return [];
}

function uriToPath(uri: string): string | undefined {
  try {
    return fileURLToPath(uri).normalize('NFC');
  } catch {
    return undefined;
  }
}
