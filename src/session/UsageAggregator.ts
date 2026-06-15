// Estima o uso local (custo + tokens) em janelas de 5h e 7 dias, varrendo os
// transcripts em ~/.claude/projects/**/*.jsonl. Aproximado, só desta máquina —
// não inclui outros dispositivos nem claude.ai (igual ao /usage oficial).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateCost } from '../stats/StatsAggregator';
import type { Usage } from '../../shared/events';

export interface LocalUsage {
  fiveHourUsd: number;
  sevenDayUsd: number;
  fiveHourTokens: number;
  sevenDayTokens: number;
}

const H = 3600_000;

export async function computeLocalUsage(nowMs: number): Promise<LocalUsage> {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const out: LocalUsage = { fiveHourUsd: 0, sevenDayUsd: 0, fiveHourTokens: 0, sevenDayTokens: 0 };
  const since7d = nowMs - 7 * 24 * H;
  const since5h = nowMs - 5 * H;

  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(base);
  } catch {
    return out;
  }

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
        accumulate(content, nowMs, since7d, since5h, out);
      } catch {
        /* ignora arquivo problemático */
      }
    }
  }
  return out;
}

function accumulate(content: string, now: number, since7d: number, since5h: number, out: LocalUsage) {
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
    if (ts >= since5h) {
      out.fiveHourUsd += cost;
      out.fiveHourTokens += tokens;
    }
  }
}
