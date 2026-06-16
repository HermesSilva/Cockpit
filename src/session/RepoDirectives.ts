// Diretivas do repositório lidas do CLAUDE.md do projeto. Diferente do conteúdo
// que o CLI injeta no contexto (instruções p/ o LLM, sem enforcement), aqui o
// Cockpit lê o arquivo p/ APLICAR regras na UI — hoje: o effort mínimo.
//
// Tag (padrão MD, dentro de um comentário p/ não poluir o texto):
//   <!-- **enffort=max** -->
// Tolerante: aceita `enffort`/`effort`/`enfor`, com/sem `**`, espaços, e em
// qualquer lugar do arquivo.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const EFFORT_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

// `enffort = <nível>`, opcionalmente em negrito; nível tem que ser conhecido.
const ENFOR_RE = /(?:enffort|effort|enfor)\s*=\s*\*{0,2}\s*(low|medium|high|xhigh|max)\b/i;

/** Extrai o effort mínimo de um texto (CLAUDE.md), ou undefined. */
export function parseMinEffort(text: string): string | undefined {
  const m = ENFOR_RE.exec(text);
  return m ? m[1].toLowerCase() : undefined;
}

/** Lê o effort mínimo de um CLAUDE.md por caminho absoluto. */
export function readMinEffortFromFile(absPath: string): string | undefined {
  try {
    return parseMinEffort(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Effort mínimo declarado no CLAUDE.md da RAIZ do projeto, ou undefined. */
export function readMinEffort(cwd: string): string | undefined {
  if (!cwd) return undefined;
  return readMinEffortFromFile(path.join(cwd, 'CLAUDE.md'));
}

/**
 * Resolve o effort mínimo aplicável a uma pasta: sobe de `dir` até `root`
 * (inclusive) e devolve o tag do CLAUDE.md MAIS específico (mais profundo) que
 * tiver um — pastas diferentes podem ter valores diferentes. Também olha
 * `<dir>/.claude/CLAUDE.md`. undefined se nenhum declara.
 */
export function resolveMinEffort(dir: string, root: string): string | undefined {
  if (!dir) return undefined;
  let cur = path.resolve(dir);
  const stop = root ? path.resolve(root) : cur;
  // Limite de segurança contra loops em caminhos estranhos.
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
