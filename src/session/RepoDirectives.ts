// Repository directives read from the project's CLAUDE.md. Unlike the content
// the CLI injects into the context (instructions for the LLM, with no enforcement), here the
// Cockpit reads the file to ENFORCE rules in the UI — today: the minimum effort.
//
// Tag (plain MD, inside a comment so it doesn't pollute the text):
//   <!-- **enffort=max** -->
// Tolerant: accepts `enffort`/`effort`/`enfor`, with/without `**`, spaces, and
// anywhere in the file.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

// `enffort = <level>`, optionally in bold; the level must be a known one.
const ENFOR_RE = /(?:enffort|effort|enfor)\s*=\s*\*{0,2}\s*(low|medium|high|xhigh|max)\b/i;

/** Extracts the minimum effort from a text (CLAUDE.md), or undefined. */
export function parseMinEffort(text: string): string | undefined {
  const m = ENFOR_RE.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/** Reads the minimum effort from a CLAUDE.md by absolute path. */
export function readMinEffortFromFile(absPath: string): string | undefined {
  try {
    return parseMinEffort(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Minimum effort declared in the CLAUDE.md at the project ROOT, or undefined. */
export function readMinEffort(cwd: string): string | undefined {
  if (!cwd) return undefined;
  return readMinEffortFromFile(path.join(cwd, 'CLAUDE.md'));
}

/**
 * Resolves the minimum effort applicable to a folder: walks up from `dir` to `root`
 * (inclusive) and returns the tag from the MOST specific (deepest) CLAUDE.md that
 * has one — different folders may have different values. It also looks at
 * `<dir>/.claude/CLAUDE.md`. undefined when none declares it.
 */
export function resolveMinEffort(dir: string, root: string): string | undefined {
  if (!dir) return undefined;
  let cur = path.resolve(dir);
  const stop = root ? path.resolve(root) : cur;
  // Safety bound against loops on odd paths.
  for (let i = 0; i < 64; i++) {
    const lvl =
      readMinEffortFromFile(path.join(cur, 'CLAUDE.md')) ??
      readMinEffortFromFile(path.join(cur, '.claude', 'CLAUDE.md'));
    if (lvl) return lvl; // mais profundo vence
    if (cur === stop) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // raiz do FS
    cur = parent;
  }
  return undefined;
}
