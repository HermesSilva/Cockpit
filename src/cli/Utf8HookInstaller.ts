// Accent (UTF-8) fix for the Windows shell tools.
//
// Problem: the Cockpit starts `claude` headless (stdio over pipes, WITHOUT a console).
// With no console attached, .NET resolves [Console]::OutputEncoding from the system
// OEMCP (e.g. 437) instead of UTF-8 — so `powershell`/`cmd` write their output
// in a legacy code page and the CLI, which reads it as UTF-8, shows mojibake. Worse: chars
// outside that CP (e.g. 'ã' in 437) are LOST at write time, so there is no possible
// fix on the decoding side. In a terminal this doesn't happen because the console is already
// at `chcp 65001`.
//
// Solution: a PreToolUse hook that prefixes every PowerShell tool command with the
// encoding setup. It is independent of the machine's code page, requires no reboot and
// changes no system setting.
//
// Safety: the hook NEVER blocks or denies a tool — any error becomes a silent
// no-op (exit 0 with no output). It is idempotent (marker in the prefix) and reversible.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marker used for (a) prefix idempotency and (b) identifying our hook. */
const MARK = 'tootega-utf8';

const HOOK_PS = String.raw`# Tootega Cockpit — PreToolUse: forces UTF-8 on the PowerShell tool output.
# Reads the hook event from stdin and returns the same tool_input with the command
# prefixed. Any failure => silent no-op (it never blocks the tool).
$ErrorActionPreference = 'Stop'

$MARK = '# tootega-utf8'
$PREAMBLE = 'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {} ' + $MARK

try {
  # Reads stdin as explicit UTF-8 (independent of the machine's console/code page).
  $stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))
  $raw = $stdin.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }

  $ev = $raw | ConvertFrom-Json
  if ($ev.tool_name -ne 'PowerShell') { exit 0 }

  $ti = $ev.tool_input
  if ($null -eq $ti) { exit 0 }
  $cmd = [string]$ti.command
  if ([string]::IsNullOrEmpty($cmd)) { exit 0 }
  if ($cmd.Contains($MARK)) { exit 0 }   # already prefixed

  # LF (and not ';') so comments, here-strings and multiline commands don't break.
  # Pure LF, never CRLF: the CLI validates updatedInput and REJECTS control
  # characters in the command (only TAB and LF pass) — a CR would invalidate the rewrite.
  $ti.command = $PREAMBLE + [string][char]10 + $cmd

  $out = [ordered]@{
    hookSpecificOutput = [ordered]@{
      hookEventName = 'PreToolUse'
      updatedInput  = $ti
    }
  }
  $json = $out | ConvertTo-Json -Depth 20 -Compress
  # Writes UTF-8 BYTES straight to stdout: [Console]::Out would use the process
  # OutputEncoding (the very OEMCP we are fixing) and would corrupt the JSON.
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

/** true when the PreToolUse entry is ours (by the script path). */
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

/** Reads the global settings.json. `undefined` = the file exists but isn't valid JSON. */
function readSettings(): any | undefined {
  const sp = settingsPath();
  try {
    return JSON.parse(fs.readFileSync(sp, 'utf8'));
  } catch {
    try {
      fs.accessSync(sp);
      return undefined; // exists and is unreadable (comments?) — don't overwrite
    } catch {
      return {}; // doesn't exist yet
    }
  }
}

/** Installs the hook in ~/.claude/settings.json. Returns 'ok' | 'unsupported' | 'parse-error'. */
export function enableUtf8Fix(): string {
  // The problem (and the PowerShell tool) only exist on Windows. On Linux/macOS the
  // shells are already UTF-8 — nothing to install.
  if (process.platform !== 'win32') return 'unsupported';

  const settings = readSettings();
  if (!settings) return 'parse-error';

  const hp = hookPath();
  fs.mkdirSync(path.dirname(hp), { recursive: true });
  fs.writeFileSync(hp, HOOK_PS, 'utf8');

  if (typeof settings.hooks !== 'object' || settings.hooks === null) settings.hooks = {};
  const list: any[] = Array.isArray(settings.hooks.PreToolUse) ? settings.hooks.PreToolUse : [];
  // Removes previous versions of our entry and preserves everyone else's.
  const kept = list.filter((e) => !isOurEntry(e));
  kept.push({
    matcher: 'PowerShell',
    hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }],
  });
  settings.hooks.PreToolUse = kept;

  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  return 'ok';
}

/** Removes the hook, preserving the other PreToolUse entries. */
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
    /* already removed */
  }
  return 'ok';
}

export const UTF8_HOOK_MARK = MARK;
