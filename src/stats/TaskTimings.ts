// Average duration per task, SEGMENTED by (model, effort, type) — because the
// same task (tool:Read, assistant, …) takes very different times depending on the
// model (opus slow, haiku fast) and the effort. GLOBAL file in
// ~/.claude/tootega/ (serves any project/tab/session). Calibrates the speed of the
// activity gauge to the real time of each combination.
//
// Robustness (v3):
//  - each key holds { ms: average, n: number of samples } — an average without a count is
//    misleading; it is only EXPOSED after a minimum N of samples (until then the gauge uses the default).
//  - incremental average: a true average for the first samples (alpha = 1/n) and EMA
//    afterwards (alpha = EMA_ALPHA), to adapt without discarding the history.
//  - it does NOT write on every sample: samples go to a buffer and the flush is debounced
//    (FLUSH_MS) — avoids rewriting the file "all the time".
//  - several windows/sessions share the SAME file: the flush takes a LOCK
//    (exclusive lockfile), re-reads the disk, MERGES the buffer into the current state and writes
//    atomically (tmp + rename). That way nobody overwrites anyone else.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const DIR = path.join(os.homedir(), '.claude', 'tootega');
const FILE = path.join(DIR, 'task-timings.json');
const LOCK = path.join(DIR, 'task-timings.lock');
const VERSION = 4; // v4: chave inclui verbosity (model::effort::verbosity::type)
const EMA_ALPHA = 0.3; // weight of the new sample once stabilized (0..1)
const MIN_MS = 150; // ignores noise (near-instant restarts)
const MAX_MS = 30 * 60_000; // ignora outliers (processo travado)
const MIN_SAMPLES = 3; // samples needed for the average to be reliable enough to expose
const SEP = ' :: '; // separador legível: `<model> :: <effort> :: <type>`
const FLUSH_MS = 5_000; // flush debounce (doesn't write on every sample)
const LOCK_RETRY_MS = 250; // when the lock is busy, it retries the flush
const LOCK_STALE_MS = 15_000; // a lock older than this is considered orphaned

interface Stat {
  ms: number; // average (incremental → EMA)
  n: number; // nº de amostras acumuladas
}
interface Store {
  version: number;
  stats: Record<string, Stat>; // `<model> :: <effort> :: <type>` -> Stat
}

// In-memory mirror for fast reads (scopes sent to the webview). It is updated
// on every flush with the merged state from disk.
let cache: Store | undefined;
// Samples not persisted yet (raw: key+ms). Applied to disk on flush.
const pending: { key: string; ms: number }[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Readable composite key for the store. */
function keyOf(model: string, effort: string, verbosity: string, type: string): string {
  return `${model}${SEP}${effort}${SEP}${verbosity}${SEP}${type}`;
}

/** Reads the store from disk (or empty). No cache — it is the base for merging on flush. */
function readStore(): Store {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (o && o.version === VERSION && o.stats && typeof o.stats === 'object') {
      return { version: VERSION, stats: o.stats };
    }
  } catch {
    /* missing/corrupted/old version: starts empty (recalibrates) */
  }
  return { version: VERSION, stats: {} };
}

/** Ensures the in-memory cache (first read from disk). */
function load(): Store {
  if (!cache) cache = readStore();
  return cache;
}

/** Applies a sample to a store (incremental average: 1/n at first, EMA afterwards). */
function applySample(store: Store, key: string, ms: number): void {
  const st = store.stats[key];
  if (!st) {
    store.stats[key] = { ms, n: 1 };
    return;
  }
  const n = st.n + 1;
  const alpha = Math.max(EMA_ALPHA, 1 / n); // true average until the EMA takes over
  st.ms = st.ms + (ms - st.ms) * alpha;
  st.n = n;
}

/** Tries to create the exclusive lockfile; removes it when orphaned. Returns the fd or undefined. */
function acquireLock(): number | undefined {
  try {
    return fs.openSync(LOCK, 'wx'); // creates it exclusively (fails when it already exists)
  } catch {
    try {
      const st = fs.statSync(LOCK);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(LOCK, { force: true }); // orphan lock (dead process): stolen
        return fs.openSync(LOCK, 'wx');
      }
    } catch {
      /* vanished between the stat and the rm: let the caller retry */
    }
    return undefined;
  }
}

function releaseLock(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* noop */
  }
  try {
    fs.rmSync(LOCK, { force: true });
  } catch {
    /* noop */
  }
}

function scheduleSave(delay = FLUSH_MS): void {
  if (saveTimer) return; // a flush is already scheduled (debounce)
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    flush();
  }, delay);
}

/** Persists the buffer: lock → re-read disk → merge → atomic write → refresh cache. */
function flush(): void {
  if (pending.length === 0) return;
  const fd = acquireLock();
  if (fd == null) {
    scheduleSave(LOCK_RETRY_MS); // lock busy: retries soon, without losing the buffer
    return;
  }
  // Takes the batch now; new samples during the flush go to the next one.
  const batch = pending.splice(0, pending.length);
  try {
    const base = readStore(); // fresh state (includes what other windows wrote)
    for (const s of batch) applySample(base, s.key, s.ms);
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(base, null, 2));
    fs.renameSync(tmp, FILE); // atomic swap (libuv uses replace-existing)
    cache = base; // espelho passa a refletir o estado mesclado
  } catch (e) {
    pending.unshift(...batch); // falhou: devolve o lote p/ tentar de novo
    log(`task-timings flush fail: ${String(e)}`);
    scheduleSave(LOCK_RETRY_MS);
  } finally {
    releaseLock(fd);
  }
}

/**
 * Averages for the requested scope (model, effort, verbosity) only, with the key reduced to
 * the plain `type` — the webview queries by type (tool:Read/assistant) without knowing the
 * scope. Only keys with >= MIN_SAMPLES samples (reliable ones) get in.
 */
export function taskTimingsScoped(
  model: string,
  effort: string,
  verbosity: string,
): Record<string, number> {
  const prefix = `${model}${SEP}${effort}${SEP}${verbosity}${SEP}`;
  const out: Record<string, number> = {};
  for (const [k, st] of Object.entries(load().stats)) {
    if (k.startsWith(prefix) && st.n >= MIN_SAMPLES) out[k.slice(prefix.length)] = st.ms;
  }
  return out;
}

/** Queues a sample (ms) for (model, effort, verbosity, type); persists debounced. */
export function recordTaskTiming(
  model: string,
  effort: string,
  verbosity: string,
  type: string,
  ms: number,
): void {
  if (!model || !type || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return;
  pending.push({ key: keyOf(model, effort || 'default', verbosity || 'verbose', type), ms });
  scheduleSave();
}
