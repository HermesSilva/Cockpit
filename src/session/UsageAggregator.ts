// Estima o uso local (custo + tokens) em janelas de 5h e 7 dias, varrendo os
// transcripts em ~/.claude/projects/**/*.jsonl. Aproximado, só desta máquina —
// não inclui outros dispositivos nem claude.ai (igual ao /usage oficial).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateCost, normalizeModel } from '../stats/StatsAggregator';
import { usageKey } from '../stats/usageKey';
import type { Usage } from '../../shared/events';

/** Acúmulo de USD + tokens de uma categoria (modelo ou origem). */
export interface UsageSlice {
  key: string; // id do modelo, ou 'main'|'subagent'
  usd: number;
  tokens: number; // tokens NOVOS: input + output + cache-create
  cacheRead: number; // contexto relido do cache (exibido à parte: domina o total)
}

/** Detalhamento do uso local da janela de 7 dias (categorias). */
export interface UsageBreakdown {
  byModel: UsageSlice[]; // por modelo (maior primeiro)
  bySource: UsageSlice[]; // main vs. subagent (sidechain)
}

/** Quanto uma ferramenta injetou de contexto (soma dos tool_result). */
export interface ToolContextSlice {
  key: string; // nome da tool; p/ MCP, "mcp:<servidor>"; p/ skill, "skill:<nome>"
  calls: number;
  tokens: number; // ESTIMATIVA: chars do tool_result / 4
}

/**
 * Atribuição do uso de 7 dias — responde "para onde foram meus tokens".
 * Percentuais são sobre os tokens NOVOS da janela (não sobre o cache-read).
 */
export interface UsageAttribution {
  longContextPct: number; // 0..1 — parcela gerada com contexto > 150k
  subagentPct: number; // 0..1 — parcela vinda de subagentes (sidechain)
  cacheHitPct?: number; // 0..1 — cache_read / (cache_read + cache_creation)
  byTool: ToolContextSlice[]; // contexto injetado por ferramenta (maior primeiro)
}

export interface LocalUsage {
  fiveHourUsd: number;
  sevenDayUsd: number;
  fiveHourTokens: number; // tokens NOVOS (sem cache-read)
  sevenDayTokens: number;
  fiveHourCacheRead: number;
  sevenDayCacheRead: number;
  breakdown: UsageBreakdown; // detalhamento da janela de 7 dias
  attribution: UsageAttribution; // atribuição da janela de 7 dias
}

/** Contexto acima do qual o turno conta como "long context" (mesmo corte do /usage). */
const LONG_CONTEXT_TOKENS = 150_000;
/** tool_result vem como texto: 4 chars ≈ 1 token (aproximação usual). */
const CHARS_PER_TOKEN = 4;

const H = 3600_000;

export async function computeLocalUsage(nowMs: number): Promise<LocalUsage> {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const out: LocalUsage = {
    fiveHourUsd: 0,
    sevenDayUsd: 0,
    fiveHourTokens: 0,
    sevenDayTokens: 0,
    fiveHourCacheRead: 0,
    sevenDayCacheRead: 0,
    breakdown: { byModel: [], bySource: [] },
    attribution: { longContextPct: 0, subagentPct: 0, byTool: [] },
  };
  const since7d = nowMs - 7 * 24 * H;
  const since5h = nowMs - 5 * H;

  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(base);
  } catch {
    return out;
  }

  // Acúmulo da janela de 7d por categoria (modelo / origem main|subagent).
  const byModel = new Map<string, UsageSlice>();
  const bySource = new Map<string, UsageSlice>();
  const attr: AttrAcc = {
    longCtxTokens: 0,
    subagentTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    byTool: new Map(),
  };

  for (const d of dirs) {
    const dir = path.join(base, d);
    let files: fs.Dirent[];
    try {
      files = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const full = path.join(dir, f.name);
      try {
        const st = await fs.promises.stat(full);
        if (st.mtimeMs < since7d) continue; // arquivo só com dados antigos
        const content = await fs.promises.readFile(full, 'utf8');
        accumulate(content, nowMs, since7d, since5h, out, byModel, bySource, attr);
      } catch {
        /* ignora arquivo problemático */
      }
    }
  }

  // Maiores primeiro (USD). bySource segue ordem fixa main→subagent p/ leitura estável.
  // `<synthetic>` é marcador do CLI (turnos sem chamada real), não um modelo: fora.
  out.breakdown.byModel = [...byModel.values()]
    .filter((s) => s.key !== '<synthetic>' && (s.tokens > 0 || s.cacheRead > 0))
    .sort((a, b) => b.usd - a.usd);
  out.breakdown.bySource = ['main', 'subagent']
    .map((k) => bySource.get(k))
    .filter((s): s is UsageSlice => !!s && s.tokens > 0);

  const denom = out.sevenDayTokens || 1;
  const cacheTotal = attr.cacheRead + attr.cacheCreate;
  out.attribution = {
    longContextPct: attr.longCtxTokens / denom,
    subagentPct: attr.subagentTokens / denom,
    cacheHitPct: cacheTotal > 0 ? attr.cacheRead / cacheTotal : undefined,
    byTool: [...attr.byTool.values()].filter((s) => s.tokens > 0).sort((a, b) => b.tokens - a.tokens),
  };
  return out;
}

/** Acúmulo bruto da atribuição (vira percentuais no fim). */
interface AttrAcc {
  longCtxTokens: number;
  subagentTokens: number;
  cacheRead: number;
  cacheCreate: number;
  byTool: Map<string, ToolContextSlice>;
}

/**
 * Agrupa a ferramenta para atribuição: tools de MCP viram "mcp:<servidor>"
 * (o que interessa é qual servidor infla o contexto, não cada tool dele) e
 * skills viram "skill:<nome>". As demais ficam com o próprio nome.
 */
function toolBucket(name: string, input: any): string {
  if (name.startsWith('mcp__')) return `mcp:${name.split('__')[1] ?? '?'}`;
  if (name === 'Skill' && typeof input?.skill === 'string') return `skill:${input.skill}`;
  return name;
}

/** Tamanho (em chars) do conteúdo de um tool_result — texto ou blocos. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (typeof b === 'string') n += b.length;
    else if (b && typeof b === 'object' && typeof (b as any).text === 'string') {
      n += (b as any).text.length;
    }
  }
  return n;
}

/** Soma USD+tokens num slot do mapa de categoria (cria sob demanda). */
function bump(
  map: Map<string, UsageSlice>,
  key: string,
  usd: number,
  tokens: number,
  cacheRead: number,
): void {
  const s = map.get(key) ?? { key, usd: 0, tokens: 0, cacheRead: 0 };
  s.usd += usd;
  s.tokens += tokens;
  s.cacheRead += cacheRead;
  map.set(key, s);
}

function accumulate(
  content: string,
  now: number,
  since7d: number,
  since5h: number,
  out: LocalUsage,
  byModel: Map<string, UsageSlice>,
  bySource: Map<string, UsageSlice>,
  attr: AttrAcc,
) {
  const counted = new Set<string>(); // ids já contados neste arquivo (ver usageKey)
  // tool_use_id -> bucket da tool. O tool_result vem numa linha `user` posterior,
  // sem o nome da tool; o vínculo só existe dentro do mesmo arquivo.
  const toolOf = new Map<string, string>();
  for (const line of content.split('\n')) {
    const isAssistant = line.includes('"assistant"');
    if (!isAssistant && !line.includes('"tool_result"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.timestamp) continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts) || ts < since7d) continue;

    // Linhas `user` só interessam pelo tool_result: quanto a tool injetou no contexto.
    if (o.type === 'user') {
      for (const b of asBlocks(o.message?.content)) {
        if (b?.type !== 'tool_result') continue;
        const bucket = toolOf.get(b.tool_use_id);
        if (!bucket) continue; // tool_use fora da janela / arquivo: não atribui
        const slice = attr.byTool.get(bucket) ?? { key: bucket, calls: 0, tokens: 0 };
        slice.calls += 1;
        slice.tokens += Math.round(resultChars(b.content) / CHARS_PER_TOKEN);
        attr.byTool.set(bucket, slice);
      }
      continue;
    }
    if (o.type !== 'assistant' || !o.message?.usage) continue;

    // Nome de cada tool_use, p/ casar com o tool_result adiante (mesmo em linha duplicada).
    for (const b of asBlocks(o.message.content)) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        toolOf.set(b.id, toolBucket(String(b.name ?? '?'), b.input));
      }
    }

    const key = usageKey(o);
    if (key) {
      if (counted.has(key)) continue; // mesma resposta, outro bloco: usage já somada
      counted.add(key);
    }
    const u = o.message.usage as Usage;
    const cost = estimateCost(u, o.message.model);
    // Tokens "novos" (o que de fato entrou/saiu neste turno). O cache-read é o
    // contexto relido a cada turno: some ~97% do total e é somado à parte.
    const tokens =
      (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    out.sevenDayUsd += cost;
    out.sevenDayTokens += tokens;
    out.sevenDayCacheRead += cacheRead;
    // Atribuição 7d: contexto do turno = tudo que o modelo leu para responder.
    const ctx = (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
    if (ctx > LONG_CONTEXT_TOKENS) attr.longCtxTokens += tokens;
    if (o.isSidechain) attr.subagentTokens += tokens;
    attr.cacheRead += cacheRead;
    attr.cacheCreate += u.cache_creation_input_tokens ?? 0;
    // Detalhamento 7d: por modelo (normalizado) e por origem (sidechain = subagent).
    bump(byModel, normalizeModel(o.message.model) ?? 'unknown', cost, tokens, cacheRead);
    bump(bySource, o.isSidechain ? 'subagent' : 'main', cost, tokens, cacheRead);
    if (ts >= since5h) {
      out.fiveHourUsd += cost;
      out.fiveHourTokens += tokens;
      out.fiveHourCacheRead += cacheRead;
    }
  }
}

/** Content de uma mensagem: array de blocos, ou vazio quando é texto puro. */
function asBlocks(content: unknown): any[] {
  return Array.isArray(content) ? content : [];
}
