// Estima o uso local (custo + tokens) em janelas de 5h e 7 dias, varrendo os
// transcripts em ~/.claude/projects/**/*.jsonl. Aproximado, só desta máquina —
// não inclui outros dispositivos nem claude.ai (igual ao /usage oficial).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateCost, normalizeModel } from '../stats/StatsAggregator';
import type { Usage } from '../../shared/events';

/** Acúmulo de USD + tokens de uma categoria (modelo ou origem). */
export interface UsageSlice {
  key: string; // id do modelo, ou 'main'|'subagent'
  usd: number;
  tokens: number;
}

/** Detalhamento do uso local da janela de 7 dias (categorias). */
export interface UsageBreakdown {
  byModel: UsageSlice[]; // por modelo (maior primeiro)
  bySource: UsageSlice[]; // main vs. subagent (sidechain)
}

export interface LocalUsage {
  fiveHourUsd: number;
  sevenDayUsd: number;
  fiveHourTokens: number;
  sevenDayTokens: number;
  breakdown: UsageBreakdown; // detalhamento da janela de 7 dias
}

const H = 3600_000;

export async function computeLocalUsage(nowMs: number): Promise<LocalUsage> {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const out: LocalUsage = {
    fiveHourUsd: 0,
    sevenDayUsd: 0,
    fiveHourTokens: 0,
    sevenDayTokens: 0,
    breakdown: { byModel: [], bySource: [] },
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
        accumulate(content, nowMs, since7d, since5h, out, byModel, bySource);
      } catch {
        /* ignora arquivo problemático */
      }
    }
  }

  // Maiores primeiro (USD). bySource segue ordem fixa main→subagent p/ leitura estável.
  out.breakdown.byModel = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  out.breakdown.bySource = ['main', 'subagent']
    .map((k) => bySource.get(k))
    .filter((s): s is UsageSlice => !!s && s.tokens > 0);
  return out;
}

/** Soma USD+tokens num slot do mapa de categoria (cria sob demanda). */
function bump(map: Map<string, UsageSlice>, key: string, usd: number, tokens: number): void {
  const s = map.get(key) ?? { key, usd: 0, tokens: 0 };
  s.usd += usd;
  s.tokens += tokens;
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
) {
  for (const line of content.split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('usage')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || !o.message?.usage || !o.timestamp) continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts) || ts < since7d) continue;
    const u = o.message.usage as Usage;
    const cost = estimateCost(u, o.message.model);
    const tokens =
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    out.sevenDayUsd += cost;
    out.sevenDayTokens += tokens;
    // Detalhamento 7d: por modelo (normalizado) e por origem (sidechain = subagent).
    bump(byModel, normalizeModel(o.message.model) ?? 'unknown', cost, tokens);
    bump(bySource, o.isSidechain ? 'subagent' : 'main', cost, tokens);
    if (ts >= since5h) {
      out.fiveHourUsd += cost;
      out.fiveHourTokens += tokens;
    }
  }
}
