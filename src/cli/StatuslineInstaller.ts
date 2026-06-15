// Integração de statusline para capturar o rate_limits real da conta.
// Instala um wrapper que: (1) grava rate_limits/context em ~/.claude/.tootega-usage.json,
// (2) re-invoca a statusline original do usuário (preservando, ex.: o badge caveman).
// Reversível. Windows (PowerShell) por enquanto.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const USAGE_CACHE = path.join(os.homedir(), '.claude', '.tootega-usage.json');

const WRAPPER_PS = String.raw`param([string]$Original = "")
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }

$raw = ""
try { if ([Console]::IsInputRedirected) { $raw = [Console]::In.ReadToEnd() } } catch {}

# 1) Grava o cache para a extensão Tootega (rate_limits + contexto).
if ($raw.Trim().Length -gt 0) {
  try {
    $j = $raw | ConvertFrom-Json
    $cache = [ordered]@{
      ts             = (Get-Date).ToUniversalTime().ToString("o")
      rate_limits    = $j.rate_limits
      context_window = $j.context_window
    }
    ($cache | ConvertTo-Json -Depth 12) | Out-File -FilePath (Join-Path $ClaudeDir ".tootega-usage.json") -Encoding utf8
  } catch {}
}

# 2) Re-emite a statusline original (preserva caveman etc.).
$printed = $false
if ($Original.Length -gt 0) {
  try {
    $cmd = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Original))
    $res = ($raw | & $env:ComSpec /c $cmd 2>$null | Out-String)
    if ($null -ne $res -and $res.Trim().Length -gt 0) { [Console]::Write($res.TrimEnd()); $printed = $true }
  } catch {}
}
if (-not $printed) {
  $badge = ""
  $flag = Join-Path $ClaudeDir ".caveman-active"
  if (Test-Path $flag) { $badge = "[CAVEMAN] " }
  [Console]::Write($badge)
}
`;

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function wrapperPath(): string {
  return path.join(os.homedir(), '.claude', '.tootega', 'statusline-wrapper.ps1');
}

function isOurWrapper(cmd: unknown): boolean {
  return typeof cmd === 'string' && cmd.includes('statusline-wrapper.ps1');
}

/**
 * Extrai e decodifica o argumento -Original "<b64>" de um comando wrapper.
 * Permite recuperar a statusline original mesmo quando a memória da extensão
 * está vazia (ex.: wrapper instalado por fora do fluxo normal). '' -> undefined.
 */
function decodeOriginalArg(cmd: string): string | undefined {
  const m = cmd.match(/-Original\s+"([^"]*)"/);
  if (!m) return undefined;
  try {
    return Buffer.from(m[1], 'base64').toString('utf8') || undefined;
  } catch {
    return undefined;
  }
}

export function isEnabled(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return isOurWrapper(s?.statusLine?.command);
  } catch {
    return false;
  }
}

/** Instala o wrapper. Retorna mensagem para o usuário. */
export function enableUsageTracking(memory: vscode.Memento): string {
  if (process.platform !== 'win32') {
    return 'unsupported';
  }
  const sp = settingsPath();
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {
    // arquivo pode não existir ou ter comentários
    try {
      fs.accessSync(sp);
      return 'parse-error';
    } catch {
      settings = {};
    }
  }

  const cur = settings?.statusLine?.command;
  // Captura a statusline original (a não ser que já seja a nossa).
  if (typeof cur === 'string' && cur) {
    if (!isOurWrapper(cur)) {
      void memory.update('statuslineOriginal', cur);
    } else if (!memory.get<string>('statuslineOriginal', '')) {
      // Re-enable sobre wrapper instalado por fora: recupera a original do -Original.
      const recovered = decodeOriginalArg(cur);
      if (recovered) void memory.update('statuslineOriginal', recovered);
    }
  }
  const original = memory.get<string>('statuslineOriginal', '');

  const wp = wrapperPath();
  fs.mkdirSync(path.dirname(wp), { recursive: true });
  fs.writeFileSync(wp, WRAPPER_PS, 'utf8');

  const b64 = Buffer.from(original, 'utf8').toString('base64');
  const command = `powershell -NoProfile -ExecutionPolicy Bypass -File "${wp}" -Original "${b64}"`;
  settings.statusLine = { type: 'command', command };
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2), 'utf8');
  return 'ok';
}

/** Remove o wrapper, restaurando a statusline original. */
export function disableUsageTracking(memory: vscode.Memento): string {
  const sp = settingsPath();
  let settings: any = {};
  try {
    settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {
    return 'parse-error';
  }
  let original = memory.get<string>('statuslineOriginal', '');
  if (!original) {
    // Memória vazia (wrapper instalado por fora): recupera do -Original do comando atual.
    const cur = settings?.statusLine?.command;
    if (typeof cur === 'string' && isOurWrapper(cur)) original = decodeOriginalArg(cur) ?? '';
  }
  if (original) {
    settings.statusLine = { type: 'command', command: original };
  } else {
    delete settings.statusLine;
  }
  fs.writeFileSync(sp, JSON.stringify(settings, null, 2), 'utf8');
  return 'ok';
}
