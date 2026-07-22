// Reads Claude Code defaults from ~/.claude/settings.json (model, effortLevel).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function readClaudeDefaults(): { model?: string; effort?: string } {
  try {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const model = typeof obj?.model === 'string' && obj.model ? obj.model : undefined;
    const effort =
      typeof obj?.effortLevel === 'string' && obj.effortLevel ? obj.effortLevel : undefined;
    return { model, effort };
  } catch {
    return {};
  }
}
