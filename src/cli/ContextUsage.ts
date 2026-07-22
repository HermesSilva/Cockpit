// Leitura do `get_context_usage` — control_request do protocolo de controle do CLI
// (mesma família de `initialize` / `can_use_tool`). É cálculo LOCAL do engine: não gasta
// tokens, não cria turno e não polui o transcript — diferente de rodar `/context`.
//
// Resposta real (CLI 2.1.217), recortada:
//   { categories:[{name:"Skills",tokens:1928},…],
//     skills:{ totalSkills:14, includedSkills:14, tokens:1928,
//              skillFrontmatter:[{name:"caveman",source:"userSettings",tokens:134},…] } }
//
// Parse TOLERANTE A VERSÃO: qualquer campo ausente/em formato inesperado vira `undefined`,
// nunca lança. Se o CLI mudar o payload, o painel esvazia — a UI não quebra.

/** Custo de metadados de uma skill no listing (o "leve"). */
export interface SkillMeta {
  name: string;
  source?: string;
  tokens?: number;
}

/** Recorte do get_context_usage que o painel de skills consome. */
export interface ContextUsageInfo {
  skills: SkillMeta[];
  listingTokens?: number; // categoria "Skills"
  totalSkills?: number;
  includedSkills?: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

/** Tokens da categoria de nome `label` em `categories[]`. */
function categoryTokens(categories: unknown, label: string): number | undefined {
  if (!Array.isArray(categories)) return undefined;
  for (const c of categories) {
    if (c && typeof c === 'object' && (c as any).name === label) return int((c as any).tokens);
  }
  return undefined;
}

/**
 * Extrai o recorte de skills da resposta. Devolve `undefined` quando o payload não
 * traz nada reconhecível (CLI antigo/novo) — o chamador simplesmente não atualiza nada.
 */
export function parseContextUsage(payload: unknown): ContextUsageInfo | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as any;
  const sk = p.skills;
  const frontmatter = Array.isArray(sk?.skillFrontmatter) ? sk.skillFrontmatter : undefined;
  const listingTokens = int(sk?.tokens) ?? categoryTokens(p.categories, 'Skills');
  if (!frontmatter && listingTokens === undefined) return undefined;

  const skills: SkillMeta[] = [];
  for (const f of frontmatter ?? []) {
    const name = str(f?.name);
    if (!name) continue;
    skills.push({ name, source: str(f?.source), tokens: int(f?.tokens) });
  }
  return {
    skills,
    listingTokens,
    totalSkills: int(sk?.totalSkills),
    includedSkills: int(sk?.includedSkills) ?? (frontmatter ? skills.length : undefined),
  };
}
