// Persistência das estatísticas POR SESSÃO (contexto). Cada sessionId tem seu
// arquivo em ~/.claude/tootega/stats/<sessionId>.json. Ao reabrir/retomar um
// contexto, o StatsAggregator é hidratado deste arquivo e CONTINUA a contar —
// o CLI não re-emite o usage dos turnos antigos no --resume, então re-derivar é
// impossível: persistir é a única forma de manter os números coerentes.
//
// Escrita: debounced (não grava a cada token) + atômica (tmp + rename). Um
// contexto é "de propriedade" da janela que o tem aberto; em caso raro de duas
// janelas com a mesma sessão, vale o último a gravar (sem merge cross-processo).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, dlog } from '../util/logger';
import type { TimelineSample, CompactionEvent, ModelUsage } from '../../shared/protocol';

const DIR = path.join(os.homedir(), '.claude', 'tootega', 'stats');
export const STATS_VERSION = 1;
const FLUSH_MS = 4_000; // debounce do flush
const TIMELINE_CAP = 400; // amostras de timeline mantidas por sessão (decima as antigas)

/** Estado serializável de uma sessão — espelha os acumuladores do StatsAggregator. */
export interface PersistedStats {
  version: number;
  sessionId: string;
  cwd?: string; // pasta de trabalho — p/ o CacheKeeper retomar com a aba fechada
  keepCacheAlive?: boolean; // reenviar antes do cache de 1h expirar
  model?: string;
  mode?: string;
  contextLimit: number;
  autoLimit: boolean;
  sessionStartTs?: number;
  // Totais acumulados
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  sessionCostUsd: number;
  costIsEstimate: boolean;
  // Contadores
  turnCount: number;
  cacheResetCount: number; // resets de cache por TTL frio
  cacheRecacheCostUsd: number; // $ re-pago em cacheWrite por causa dos resets
  compactionCount: number;
  reopenCount: number; // quantas vezes o contexto foi reaberto/retomado
  peakContextUsed: number;
  peakContextTs?: number;
  activeMs: number; // tempo de execução real (soma dos prompts, sem ociosidade)
  // Estado p/ detecção entre turnos (não exibido, mas precisa sobreviver ao reopen)
  lastContextUsed: number;
  lastCacheRead: number;
  lastTurnTs: number;
  // Detalhamento
  perModel: Record<string, ModelUsage>;
  toolDecisions: Record<string, { allow: number; allowAlways: number; deny: number }>;
  timeline: TimelineSample[];
  compactions: CompactionEvent[];
  updatedAt: string; // ISO 8601
}

function fileFor(sessionId: string): string {
  // sessionId já é um uuid/slug seguro (nome do .jsonl); normaliza por garantia.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${safe}.json`);
}

/** Lê o estado persistido de uma sessão (ou undefined se ausente/incompatível). */
export function loadStats(sessionId: string): PersistedStats | undefined {
  if (!sessionId) return undefined;
  try {
    const o = JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8'));
    if (o && o.version === STATS_VERSION && o.sessionId) return o as PersistedStats;
  } catch {
    /* ausente/corrompido/versão antiga: começa do zero p/ esta sessão */
  }
  return undefined;
}

// --- Lock de keep-alive por sessão (coordena VÁRIAS instâncias do VSCode) ---
// Cada instância tem seu CacheKeeper varrendo o MESMO diretório. Sem coordenação,
// duas instâncias pingam a mesma sessão no mesmo tick. O lock é um arquivo
// exclusivo curtíssimo: segura só a seção crítica (re-ler fresco → decidir →
// bump). Quem perde o lock pula. Lock órfão (instância morta) é roubado após
// LOCK_STALE_MS. O sinal real entre instâncias é o lastTurnTs no disco (o bump).
const LOCK_STALE_MS = 30_000;
const heldLocks = new Map<string, number>(); // sessionId -> fd aberto

function lockPath(sessionId: string): string {
  return `${fileFor(sessionId)}.lock`;
}

/** Tenta a posse exclusiva do keep-alive desta sessão. true = adquiriu. */
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
    // Ocupado: rouba se for órfão (instância morta deixou o lock).
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        heldLocks.set(sessionId, fs.openSync(lock, 'wx'));
        return true;
      }
    } catch {
      /* sumiu entre o stat e o open: deixa p/ o próximo tick */
    }
    return false;
  }
}

/** Libera o lock de keep-alive desta sessão (no-op se não o detém). */
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

/** Lê o estado persistido de TODAS as sessões (p/ o CacheKeeper varrer). */
export function loadAllStats(): PersistedStats[] {
  let names: string[];
  try {
    names = fs.readdirSync(DIR);
  } catch {
    return []; // diretório ainda não existe
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
 * Reinicia a "vida" do cache de uma sessão (lastTurnTs = agora) após um
 * keep-alive bem-sucedido. Gravação síncrona e atômica — o keeper precisa do
 * estado fresco já no disco antes do próximo tick. Não mexe em mais nada.
 */
export function bumpCacheActivity(sessionId: string, ts: number): void {
  const s = loadStats(sessionId);
  if (!s) return;
  s.lastTurnTs = ts;
  s.updatedAt = new Date(ts).toISOString();
  pending.set(sessionId, s); // garante que um saveStats pendente não regrida
  flushStats();
  dlog('stats', `cache activity bump ${sessionId} → lastTurnTs=${s.updatedAt}`);
}

// Buffer de gravação: 1 estado pendente por sessão (o mais recente vence).
const pending = new Map<string, PersistedStats>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Enfileira o estado de uma sessão p/ persistir; grava debounced e atômico. */
export function saveStats(data: PersistedStats): void {
  if (!data.sessionId) return;
  pending.set(data.sessionId, data);
  if (!saveTimer) saveTimer = setTimeout(flushStats, FLUSH_MS);
}

/** Grava imediatamente tudo que está pendente (chamar no deactivate da extensão). */
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
      fs.renameSync(tmp, dst); // troca atômica
    } catch (e) {
      log(`stats-store flush fail (${sessionId}): ${String(e)}`);
    }
  }
  pending.clear();
  dlog('stats', `flush ${ids.length} sessão(ões): ${ids.join(', ')}`);
}

/** Decima a timeline mantendo as amostras recentes densas e ralando as antigas. */
export function capTimeline(timeline: TimelineSample[]): TimelineSample[] {
  if (timeline.length <= TIMELINE_CAP) return timeline;
  // Mantém a metade recente intacta; remove 1 a cada 2 da metade antiga.
  const half = Math.floor(timeline.length / 2);
  const old = timeline.slice(0, half).filter((_, i) => i % 2 === 0);
  return [...old, ...timeline.slice(half)];
}
