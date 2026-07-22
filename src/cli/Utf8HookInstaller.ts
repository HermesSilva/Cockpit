// Correção de acentuação (UTF-8) nas tools de shell do Windows.
//
// Problema: o Cockpit sobe o `claude` headless (stdio em pipes, SEM console).
// Sem console anexado, o .NET resolve [Console]::OutputEncoding pelo OEMCP do
// sistema (ex.: 437) em vez de UTF-8 — então `powershell`/`cmd` escrevem a saída
// em code page legada e o CLI, que lê como UTF-8, mostra mojibake. Pior: chars
// fora da CP (ex.: 'ã' na 437) são PERDIDOS na escrita, então não há conserto
// possível do lado do decode. No terminal isso não aparece porque o console já
// está em `chcp 65001`.
//
// Solução: um hook PreToolUse que prefixa todo comando da tool PowerShell com o
// ajuste de encoding. Independe de code page da máquina, não exige reboot e não
// altera nenhuma configuração do sistema.
//
// Segurança: o hook NUNCA bloqueia nem nega uma tool — qualquer erro vira no-op
// silencioso (exit 0 sem saída). É idempotente (marcador no prefixo) e reversível.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marcador usado para (a) idempotência do prefixo e (b) identificar nosso hook. */
const MARK = 'tootega-utf8';

const HOOK_PS = String.raw`# Tootega Cockpit — PreToolUse: força UTF-8 na saída da tool PowerShell.
# Lê o evento do hook no stdin e devolve o mesmo tool_input com o comando
# prefixado. Qualquer falha => no-op silencioso (nunca bloqueia a tool).
$ErrorActionPreference = 'Stop'

$MARK = '# tootega-utf8'
$PREAMBLE = 'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {} ' + $MARK

try {
  # Lê o stdin como UTF-8 explícito (não depende do console/code page da máquina).
  $stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
  $raw = $stdin.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

  $ev = $raw | ConvertFrom-Json
  if ($ev.tool_name -ne 'PowerShell') { exit 0 }

  $ti = $ev.tool_input
  if ($null -eq $ti) { exit 0 }
  $cmd = [string]$ti.command
  if ([string]::IsNullOrEmpty($cmd)) { exit 0 }
  if ($cmd.Contains($MARK)) { exit 0 }   # já prefixado

  # LF (e não ';') p/ não quebrar comentários, here-strings e comandos multilinha.
  # LF puro, nunca CRLF: o CLI valida o updatedInput e REJEITA caracteres de
  # controle no comando (só TAB e LF passam) — um CR invalidaria a reescrita.
  $ti.command = $PREAMBLE + [string][char]10 + $cmd

  $out = [ordered]@{
    hookSpecificOutput = [ordered]@{
      hookEventName = 'PreToolUse'
      updatedInput  = $ti
    }
  }
  $json = $out | ConvertTo-Json -Depth 20 -Compress
  # Escreve BYTES UTF-8 direto no stdout: [Console]::Out usaria o OutputEncoding
  # do processo (o mesmo OEMCP que estamos consertando) e corromperia o JSON.
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} catch {
  exit 0
}
exit 0
`;

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function hookPath(): string {
  return path.join(os.homedir(), '.claude', '.tootega', 'utf8-hook.ps1');
}

function hookCommand(): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${hookPath()}"`;
}

/** true se a entrada de PreToolUse é a nossa (pelo caminho do script). */
function isOurEntry(entry: any): boolean {
  const hooks = entry?.hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes('utf8-hook.ps1'));
}

export function isEnabled(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const list = s?.hooks?.PreToolUse;
    return Array.isArray(list) && list.some(isOurEntry);
  } catch {
    return false;
  }
}

/** Lê o settings.json global. `undefined` = arquivo existe mas não é JSON válido. */
function readSettings(): any | undefined {
  const sp = settingsPath();
  try {
    return JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {
    try {
      fs.accessSync(sp);
      return undefined; // existe e está ilegível (comentários?) — não sobrescrever
    } catch {
      return {}; // ainda não existe
    }
  }
}

/** Instala o hook em ~/.claude/settings.json. Retorna 'ok' | 'unsupported' | 'parse-error'. */
export function enableUtf8Fix(): string {
  // O problema (e a tool PowerShell) só existem no Windows. Em Linux/macOS as
  // shells já são UTF-8 — nada a instalar.
  if (process.platform !== 'win32') return 'unsupported';

  const settings = readSettings();
  if (!settings) return 'parse-error';

  const hp = hookPath();
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, HOOK_PS, 'utf8');

  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  const list: any[] = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  // Remove versões anteriores da nossa entrada e preserva as dos outros.
  const kept = list.filter((e) => !isOurEntry(e));
  kept.push({
    matcher: 'PowerShell',
    hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }],
  });
  settings.hooks.PreToolUse = kept;

  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return 'ok';
}

/** Remove o hook, preservando as demais entradas de PreToolUse. */
export function disableUtf8Fix(): string {
  const settings = readSettings();
  if (!settings) return 'parse-error';

  const list = settings?.hooks?.PreToolUse;
  if (Array.isArray(list)) {
    const kept = list.filter((e) => !isOurEntry(e));
    if (kept.length) settings.hooks.PreToolUse = kept;
    else delete settings.hooks.PreToolUse;
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  }
  try {
    fs.unlinkSync(hookPath());
  } catch {
    /* já removido */
  }
  return 'ok';
}

export const UTF8_HOOK_MARK = MARK;
