// Persistence of the PER-SESSION (context) statistics. Each sessionId has its
// file in ~/.claude/tootega/stats/<sessionId>.json. When reopening/resuming a
// context, the StatsAggregator is hydrated from this file and KEEPS counting —
// the CLI doesn't re-emit the usage of old turns on --resume, so re-deriving is
// impossible: persisting is the only way to keep the numbers coherent.
//
// Writing: debounced (not on every token) + atomic (tmp + rename). A
// context is "owned" by the window that has it open; in the rare case of two
// windows with the same session, the last writer wins (no cross-process merge).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, dlog } from '../util/logger';
import type { TimelineSample, CompactionEvent, ModelUsage, DenialEvent } from '../../shared/protocol';

const DIR = path.join(os.homedir(), '.claude', 'tootega', 'stats');
export const STATS_VERSION = 1;
const FLUSH_MS = 4_000; // debounce do flush
const TIMELINE_CAP = 400; // timeline samples kept per session (old ones are decimated)

/** Serializable state of a session — mirrors the StatsAggregator accumulators. */
export interface PersistedStats {
  version: number;
  sessionId: string;
  cwd?: string; // working folder — for the CacheKeeper to resume with the tab closed
  keepCacheAlive?: boolean; // re-send before the 1h cache expires
  model?: string;
  mode?: string;
  contextLimit: number;
  autoLimit: boolean;
  sessionStartTs?: number;
  // Accumulated totals
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  sessionCostUsd: number;
  costIsEstimate: boolean;
  // Counters
  turnCount: number;
  cacheResetCount: number; // resets de cache por TTL frio
  cacheRecacheCostUsd: number; // $ re-paid in cacheWrite because of the resets
  compactionCount: number;
  reopenCount: number; // how many times the context was reopened/resumed
  peakContextUsed: number;
  peakContextTs?: number;
  activeMs: number; // real execution time (sum of the prompts, without idleness)
  // State for between-turn detection (not displayed, but must survive a reopen)
  lastContextUsed: number;
  lastCacheRead: number;
  lastTurnTs: number;
  // Breakdown
  perModel: Record<string, ModelUsage>;
  toolDecisions: Record<string, { allow: number; allowAlways: number; deny: number }>;
  denials?: DenialEvent[]; // permission denial log (E5)
  timeline: TimelineSample[];
  compactions: CompactionEvent[];
  updatedAt: string; // ISO 8601
}

function fileFor(sessionId: string): string {
  // sessionId is already a safe uuid/slug (the .jsonl name); normalized just in case.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${safe}.json`);
}

/** Reads a session's persisted state (or undefined when missing/incompatible). */
export function loadStats(sessionId: string): PersistedStats | undefined {
  if (!sessionId) return undefined;
  try {
    const o = JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8'));
    if (o && o.version === STATS_VERSION && o.sessionId) return o as PersistedStats;
  } catch {
    /* missing/corrupted/old version: starts from scratch for this session */
  }
  return undefined;
}

// --- Per-session keep-alive lock (coordinates SEVERAL VSCode instances) ---
// Every instance has its CacheKeeper sweeping the SAME directory. Without coordination,
// two instances ping the same session on the same tick. The lock is a very short-lived
// exclusive file: it holds only the critical section (re-read fresh → decide →
// bump). Whoever loses the lock skips. An orphan lock (dead instance) is stolen after
// LOCK_STALE_MS. The real signal between instances is the lastTurnTs on disk (the bump).
const LOCK_STALE_MS = 30_000;
const heldLocks = new Map<string, number>(); // sessionId -> fd aberto

function lockPath(sessionId: string): string {
  return `${fileFor(sessionId)}.lock`;
}

/** Tries to take exclusive ownership of this session's keep-alive. true = acquired. */
export function acquireKeepAliveLock(sessionId: string): boolean {
  if (!sessionId) return false;
  const lock = lockPath(sessionId);
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* noop */
  }
  try {
    heldLocks.set(sessionId, fs.openSync(lock, 'wx')); // cria exclusivo (falha se existe)
    return true;
  } catch {
    // Busy: steals it when orphaned (a dead instance left the lock behind).
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        heldLocks.set(sessionId, fs.openSync(lock, 'wx'));
        return true;
      }
    } catch {
      /* vanished between the stat and the open: leave it for the next tick */
    }
    return false;
  }
}

/** Releases this session's keep-alive lock (no-op when not held). */
export function releaseKeepAliveLock(sessionId: string): void {
  const fd = heldLocks.get(sessionId);
  if (fd != null) {
    try {
      fs.closeSync(fd);
    } catch {
      /* noop */
    }
    heldLocks.delete(sessionId);
  }
  try {
    fs.rmSync(lockPath(sessionId), { force: true });
  } catch {
    /* noop */
  }
}

/** Reads the persisted state of ALL sessions (for the CacheKeeper sweep). */
export function loadAllStats(): PersistedStats[] {
  let names: string[];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return []; // the directory doesn't exist yet
  }
  const out: PersistedStats[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    const s = loadStats(id);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Restarts a session's cache "life" (lastTurnTs = now) after a successful
 * keep-alive. Synchronous and atomic write — the keeper needs the fresh
 * state on disk before the next tick. It touches nothing else.
 */
export function bumpCacheActivity(sessionId: string, ts: number): void {
  const s = loadStats(sessionId);
  if (!s) return;
  s.lastTurnTs = ts;
  s.updatedAt = new Date(ts).toISOString();
  pending.set(sessionId, s); // makes sure a pending saveStats doesn't regress
  flushStats();
  dlog('stats', `cache activity bump ${sessionId} → lastTurnTs=${s.updatedAt}`);
}

// Write buffer: one pending state per session (the most recent wins).
const pending = new Map<string, PersistedStats>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Queues a session's state for persistence; writes debounced and atomic. */
export function saveStats(data: PersistedStats): void {
  if (!data.sessionId) return;
  pending.set(data.sessionId, data);
  if (!saveTimer) saveTimer = setTimeout(flushStats, FLUSH_MS);
}

/** Writes everything pending right away (call it in the extension's deactivate). */
export function flushStats(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  if (pending.size === 0) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* noop */
  }
  const ids = [...pending.keys()];
  for (const [sessionId, data] of pending) {
    const dst = fileFor(sessionId);
    const tmp = `${dst}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, dst); // atomic swap
    } catch (e) {
      log(`stats-store flush fail (${sessionId}): ${String(e)}`);
    }
  }
  pending.clear();
  dlog('stats', `flush ${ids.length} session(s): ${ids.join(', ')}`);
}

/** Decima a timeline mantendo as amostras recentes densas e ralando as antigas. */
export function capTimeline(timeline: TimelineSample[]): TimelineSample[] {
  if (timeline.length <= TIMELINE_CAP) return timeline;
  // Keeps the recent half intact; removes 1 in every 2 of the old half.
  const half = Math.floor(timeline.length / 2);
  const old = timeline.slice(0, half).filter((_, i) => i % 2 === 0);
  return [...old, ...timeline.slice(half)];
}
