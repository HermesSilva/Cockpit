// Estimates local usage (cost + tokens) over 5h and 7-day windows, scanning the
// transcripts in ~/.claude/projects/**/*.jsonl. Approximate, this machine only —
// it excludes other devices and claude.ai (same as the official /usage).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { estimateCost, normalizeModel } from '../stats/StatsAggregator';
import { usageKey } from '../stats/usageKey';
import type { Usage } from '../../shared/events';

/** Accumulated USD + tokens for a category (model or source). */
export interface UsageSlice {
  key: string; // id do modelo, ou 'main'|'subagent'
  usd: number;
  tokens: number; // tokens NOVOS: input + output + cache-create
  cacheRead: number; // context re-read from the cache (displayed separately: it dominates the total)
}

/** Breakdown of local usage for the 7-day window (categories). */
export interface UsageBreakdown {
  byModel: UsageSlice[]; // por modelo (maior primeiro)
  bySource: UsageSlice[]; // main vs. subagent (sidechain)
}

/** How much context a tool injected (sum of the tool_results). */
export interface ToolContextSlice {
  key: string; // nome da tool; p/ MCP, "mcp:<servidor>"; p/ skill, "skill:<nome>"
  calls: number;
  tokens: number; // ESTIMATIVA: chars do tool_result / 4
}

/**
 * 7-day usage attribution — answers "where did my tokens go".
 * Percentages are over the window's NEW tokens (not over cache-read).
 */
export interface UsageAttribution {
  longContextPct: number; // 0..1 — share generated with context > 150k
  subagentPct: number; // 0..1 — parcela vinda de subagentes (sidechain)
  cacheHitPct?: number; // 0..1 — cache_read / (cache_read + cache_creation)
  byTool: ToolContextSlice[]; // contexto injetado por ferramenta (maior primeiro)
}

export interface LocalUsage {
  fiveHourUsd: number;
  sevenDayUsd: number;
  fiveHourTokens: number; // NEW tokens (without cache-read)
  sevenDayTokens: number;
  fiveHourCacheRead: number;
  sevenDayCacheRead: number;
  breakdown: UsageBreakdown; // detalhamento da janela de 7 dias
  attribution: UsageAttribution; // attribution of the 7-day window
}

/** Context above which a turn counts as "long context" (same cut as /usage). */
const LONG_CONTEXT_TOKENS = 150_000;
/** tool_result comes as text: 4 chars ≈ 1 token (the usual approximation). */
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

  // 7d window accumulation per category (model / source main|subagent).
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
        if (st.mtimeMs < since7d) continue; // file with old data only
        const content = await fs.promises.readFile(full, 'utf8');
        accumulate(content, nowMs, since7d, since5h, out, byModel, bySource, attr);
      } catch {
        /* ignores a problematic file */
      }
    }
  }

  // Largest first (USD). bySource keeps a fixed main→subagent order for stable reading.
  // `<synthetic>` is a CLI marker (turns without a real call), not a model: excluded.
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

/** Raw accumulation for the attribution (turned into percentages at the end). */
interface AttrAcc {
  longCtxTokens: number;
  subagentTokens: number;
  cacheRead: number;
  cacheCreate: number;
  byTool: Map<string, ToolContextSlice>;
}

/**
 * Groups the tool for attribution: MCP tools become "mcp:<server>"
 * (what matters is which server inflates the context, not each of its tools) and
 * skills become "skill:<name>". The rest keep their own name.
 */
function toolBucket(name: string, input: any): string {
  if (name.startsWith('mcp__')) return `mcp:${name.split('__')[1] ?? '?'}`;
  if (name === 'Skill' && typeof input?.skill === 'string') return `skill:${input.skill}`;
  return name;
}

/** Size (in chars) of a tool_result's content — text or blocks. */
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

/** Adds USD+tokens into a slot of the category map (created on demand). */
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
  const counted = new Set<string>(); // ids already counted in this file (see usageKey)
  // tool_use_id -> the tool's bucket. The tool_result comes in a later `user` line,
  // without the tool name; the link only exists within the same file.
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

    // `user` lines only matter for the tool_result: how much the tool injected into the context.
    if (o.type === 'user') {
      for (const b of asBlocks(o.message?.content)) {
        if (b?.type !== 'tool_result') continue;
        const bucket = toolOf.get(b.tool_use_id);
        if (!bucket) continue; // tool_use outside the window / file: not attributed
        const slice = attr.byTool.get(bucket) ?? { key: bucket, calls: 0, tokens: 0 };
        slice.calls += 1;
        slice.tokens += Math.round(resultChars(b.content) / CHARS_PER_TOKEN);
        attr.byTool.set(bucket, slice);
      }
      continue;
    }
    if (o.type !== 'assistant' || !o.message?.usage) continue;

    // Name of each tool_use, to match the tool_result later (even on a duplicated line).
    for (const b of asBlocks(o.message.content)) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        toolOf.set(b.id, toolBucket(String(b.name ?? '?'), b.input));
      }
    }

    const key = usageKey(o);
    if (key) {
      if (counted.has(key)) continue; // same response, another block: usage already summed
      counted.add(key);
    }
    const u = o.message.usage as Usage;
    const cost = estimateCost(u, o.message.model);
    // "New" tokens (what actually came in/out this turn). cache-read is the
    // context re-read every turn: it is ~97% of the total and is summed separately.
    const tokens =
      (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const cacheRead = u.cache_read_input_tokens ?? 0;
    out.sevenDayUsd += cost;
    out.sevenDayTokens += tokens;
    out.sevenDayCacheRead += cacheRead;
    // 7d attribution: the turn's context = everything the model read to answer.
    const ctx = (u.input_tokens ?? 0) + cacheRead + (u.cache_creation_input_tokens ?? 0);
    if (ctx > LONG_CONTEXT_TOKENS) attr.longCtxTokens += tokens;
    if (o.isSidechain) attr.subagentTokens += tokens;
    attr.cacheRead += cacheRead;
    attr.cacheCreate += u.cache_creation_input_tokens ?? 0;
    // 7d breakdown: per model (normalized) and per source (sidechain = subagent).
    bump(byModel, normalizeModel(o.message.model) ?? 'unknown', cost, tokens, cacheRead);
    bump(bySource, o.isSidechain ? 'subagent' : 'main', cost, tokens, cacheRead);
    if (ts >= since5h) {
      out.fiveHourUsd += cost;
      out.fiveHourTokens += tokens;
      out.fiveHourCacheRead += cacheRead;
    }
  }
}

/** A message's content: array of blocks, or empty when it is plain text. */
function asBlocks(content: unknown): any[] {
  return Array.isArray(content) ? content : [];
}
