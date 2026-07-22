// GLOBAL token counter (sent / received / total), aggregated per day.
// Source: the transcripts in ~/.claude/projects/**/*.jsonl — written by the CLI and
// SHARED by every context and every VSCode instance on the
// machine. That's why the number is naturally "global": any window/context
// that ran a turn left a trace here.
//
// "sent"     = input + cache_read + cache_creation (everything sent to the model)
// "received" = output
// "total"    = sent + received
//
// Performance: scanning the WHOLE history on every open would be expensive. We keep an
// incremental rollup in ~/.claude/tootega/tokens-rollup.json: per file it stores
// mtime+size and the day→{s,r} map; a file is only re-read when it changed. The rollup is a
// derived CACHE (the .jsonl files are the truth): atomic write, last-write-wins
// between instances, no lock needed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';
import { usageKey } from './usageKey';
import type { Usage } from '../../shared/events';

/** Tokens of a single day (local YYYY-MM-DD key). */
export interface DailyTokens {
  date: string; // YYYY-MM-DD no fuso local
  sent: number; // input + cache_read + cache_creation
  received: number; // output
}

/** Global totals (all-time) + per-day slice (most recent first). */
export interface TokenTotals {
  sent: number;
  received: number;
  total: number;
  days: DailyTokens[]; // limitado p/ exibição; total é all-time
}

// v2: lines of the same response are no longer summed repeatedly (usageKey).
// The bump forces discarding the old rollup, which holds inflated totals.
const ROLLUP_VERSION = 2;
const ROLLUP = path.join(os.homedir(), '.claude', 'tootega', 'tokens-rollup.json');

/** day→{s:sent, r:received} map of ONE file. */
type FileDays = Record<string, { s: number; r: number }>;
interface FileEntry {
  mtimeMs: number;
  size: number;
  days: FileDays;
}
interface Rollup {
  version: number;
  files: Record<string, FileEntry>;
}

/** YYYY-MM-DD in the LOCAL timezone (not UTC — "per day" is the user's day). */
function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function loadRollup(): Rollup {
  try {
    const o = JSON.parse(fs.readFileSync(ROLLUP, 'utf8'));
    if (o && o.version === ROLLUP_VERSION && o.files) return o as Rollup;
  } catch {
    /* missing/corrupted/old version: starts from scratch */
  }
  return { version: ROLLUP_VERSION, files: {} };
}

function saveRollup(r: Rollup): void {
  try {
    fs.mkdirSync(path.dirname(ROLLUP), { recursive: true });
    const tmp = `${ROLLUP}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(r));
    fs.renameSync(tmp, ROLLUP); // troca atômica
  } catch (e) {
    log(`daily-tokens rollup save fail: ${String(e)}`);
  }
}

/** Reads a .jsonl and returns the day→{s,r} map of the assistant lines with usage. */
function parseFile(content: string): FileDays {
  const days: FileDays = {};
  const counted = new Set<string>(); // ids já contados neste arquivo (ver usageKey)
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
    if (Number.isNaN(ts)) continue;
    const key = usageKey(o);
    if (key) {
      if (counted.has(key)) continue; // mesma resposta, outro bloco: usage já somada
      counted.add(key);
    }
    const u = o.message.usage as Usage;
    const sent =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    const received = u.output_tokens ?? 0;
    const day = localDay(ts);
    const slot = days[day] ?? { s: 0, r: 0 };
    slot.s += sent;
    slot.r += received;
    days[day] = slot;
  }
  return days;
}

/**
 * Aggregates tokens per day across the WHOLE machine (global). `maxDays` only limits the
 * displayed slice; the sent/received/total figures are all-time.
 */
export async function computeDailyTokens(maxDays = 30): Promise<TokenTotals> {
  const base = path.join(os.homedir(), '.claude', 'projects');
  const prev = loadRollup();
  const next: Rollup = { version: ROLLUP_VERSION, files: {} };

  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(base);
  } catch {
    return { sent: 0, received: 0, total: 0, days: [] }; // sem histórico ainda
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
        const cached = prev.files[full];
        // Unchanged (same mtime+size): reuses the aggregate, doesn't re-read.
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          next.files[full] = cached;
          continue;
        }
        const content = await fs.promises.readFile(full, 'utf8');
        next.files[full] = { mtimeMs: st.mtimeMs, size: st.size, days: parseFile(content) };
      } catch {
        /* problematic file: ignored (orphan entries fall out of next) */
      }
    }
  }

  saveRollup(next);

  // Sums every file → global day→{s,r} map.
  const byDay = new Map<string, { s: number; r: number }>();
  let sent = 0;
  let received = 0;
  for (const fe of Object.values(next.files)) {
    for (const [day, v] of Object.entries(fe.days)) {
      const slot = byDay.get(day) ?? { s: 0, r: 0 };
      slot.s += v.s;
      slot.r += v.r;
      byDay.set(day, slot);
      sent += v.s;
      received += v.r;
    }
  }

  const days: DailyTokens[] = [...byDay.entries()]
    .map(([date, v]) => ({ date, sent: v.s, received: v.r }))
    .sort((a, b) => (a.date < b.date ? 1 : -1)) // mais recente primeiro
    .slice(0, maxDays);

  return { sent, received, total: sent + received, days };
}
