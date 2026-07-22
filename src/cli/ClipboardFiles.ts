// Reads the paths of files copied in the OS file manager — information the webview
// sandbox does not expose (File.path is absent). Per platform:
//   win32  : PowerShell Get-Clipboard -Format FileDropList (CF_HDROP)
//   darwin : AppleScript (the clipboard as «class furl») → POSIX path
//   linux  : text/uri-list via wl-paste (Wayland) ou xclip (X11) → file:// decodificado
// Best-effort: missing tool / no files → [].
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
      // Forces UTF-8 on the output (avoids accent corruption from the code page).
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
  // Finder copies files as file-urls. AppleScript returns the POSIX path.
  const res = spawnSync(
    'osascript',
    ['-e', 'POSIX path of (the clipboard as «class furl»)'],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (res.status !== 0) return [];
  const p = (res.stdout || '').trim();
  return p ? [p.normalize('NFC')] : []; // the «class furl» coercion yields 1 file
}

function readLinux(): string[] {
  // File managers expose the selection as text/uri-list (file://...).
  // Tries Wayland (wl-paste) then X11 (xclip); decodes file:// → path.
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
