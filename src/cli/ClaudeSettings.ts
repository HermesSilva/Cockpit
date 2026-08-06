// Reads Claude Code defaults from ~/.claude/settings.json (model, effortLevel).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function readClaudeDefaults(): { model?: string; effort?: string } {
  const obj = readJson(path.join(os.homedir(), '.claude', 'settings.json'));
  const model = typeof obj?.model === 'string' && obj.model ? obj.model : undefined;
  const effort =
    typeof obj?.effortLevel === 'string' && obj.effortLevel ? obj.effortLevel : undefined;
  return { model, effort };
}

/** An env value the CLI reads as "on" (defined and not an explicit off). */
function envOn(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s !== '' && s !== '0' && s !== 'false';
}

/**
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` — since CLI 2.1.223 it applies to **every** 1M-window model
 * (before, only to the ones that opened 1M via the `[1m]` suffix), and the CLI auto-compacts at
 * 200K. Our meter has to follow, or it shows headroom that no longer exists.
 *
 * Read from the same places the CLI does: the process environment (we spawn it, so it inherits
 * ours) and the `env` block of the settings files, project overriding user.
 */
export function oneMContextDisabled(cwd?: string): boolean {
  const KEY = 'CLAUDE_CODE_DISABLE_1M_CONTEXT';
  const files = [path.join(os.homedir(), '.claude', 'settings.json')];
  if (cwd) {
    files.push(
      path.join(cwd, '.claude', 'settings.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
    );
  }
  let on = envOn(process.env[KEY]);
  for (const f of files) {
    const env = readJson(f)?.env as Record<string, unknown> | undefined;
    if (env && typeof env === 'object' && KEY in env) on = envOn(env[KEY]);
  }
  return on;
}
