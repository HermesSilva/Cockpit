// Médias de duração por tarefa, SEGMENTADAS por (modelo, effort, tipo) — pois a
// mesma tarefa (tool:Read, assistant, …) leva tempos bem diferentes conforme o
// modelo (opus lento, haiku rápido) e o effort. Arquivo GLOBAL em
// ~/.claude/tootega/ (serve qualquer projeto/aba/sessão). Calibra a velocidade do
// gauge de atividade ao tempo real de cada combinação.
//
// Robustez (v3):
//  - cada chave guarda { ms: média, n: nº de amostras } — média sem contagem é
//    furada; só é EXPOSTA após N mínimo de amostras (até lá, gauge usa o padrão).
//  - média incremental: média verdadeira nas 1ªs amostras (alpha = 1/n) e EMA
//    depois (alpha = EMA_ALPHA), p/ adaptar sem descartar o histórico.
//  - NÃO grava a cada amostra: amostras vão p/ um buffer e o flush é debounced
//    (FLUSH_MS) — evita reescrever o arquivo "a todo momento".
//  - várias janelas/sessões compartilham o MESMO arquivo: o flush pega um LOCK
//    (lockfile exclusivo), relê o disco, MESCLA o buffer no estado atual e grava
//    de forma atômica (tmp + rename). Assim ninguém sobrescreve o outro.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const DIR = path.join(os.homedir(), '.claude', 'tootega');
const FILE = path.join(DIR, 'task-timings.json');
const LOCK = path.join(DIR, 'task-timings.lock');
const VERSION = 4; // v4: chave inclui verbosity (model::effort::verbosity::type)
const EMA_ALPHA = 0.3; // peso da amostra nova depois de estabilizada (0..1)
const MIN_MS = 150; // ignora ruído (reinícios quase instantâneos)
const MAX_MS = 30 * 60_000; // ignora outliers (processo travado)
const MIN_SAMPLES = 3; // amostras p/ a média ser confiável o bastante p/ expor
const SEP = ' :: '; // separador legível: `<model> :: <effort> :: <type>`
const FLUSH_MS = 5_000; // debounce do flush (não grava a cada amostra)
const LOCK_RETRY_MS = 250; // se o lock está ocupado, tenta o flush de novo
const LOCK_STALE_MS = 15_000; // lock mais velho que isso é considerado órfão

interface Stat {
  ms: number; // média (incremental → EMA)
  n: number; // nº de amostras acumuladas
}
interface Store {
  version: number;
  stats: Record<string, Stat>; // `<model> :: <effort> :: <type>` -> Stat
}

// Espelho em memória p/ leitura rápida (escopos enviados à webview). É atualizado
// a cada flush com o estado mesclado do disco.
let cache: Store | undefined;
// Amostras ainda não persistidas (cru: chave+ms). Aplicadas no disco no flush.
const pending: { key: string; ms: number }[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Chave composta legível p/ o store. */
function keyOf(model: string, effort: string, verbosity: string, type: string): string {
  return `${model}${SEP}${effort}${SEP}${verbosity}${SEP}${type}`;
}

/** Lê o store do disco (ou vazio). Não usa cache — é a base p/ mesclar no flush. */
function readStore(): Store {
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (o && o.version === VERSION && o.stats && typeof o.stats === 'object') {
      return { version: VERSION, stats: o.stats };
    }
  } catch {
    /* ausente/corrompido/versão antiga: começa vazio (recalibra) */
  }
  return { version: VERSION, stats: {} };
}

/** Garante o cache em memória (1ª leitura do disco). */
function load(): Store {
  if (!cache) cache = readStore();
  return cache;
}

/** Aplica uma amostra a um store (média incremental: 1/n no começo, EMA depois). */
function applySample(store: Store, key: string, ms: number): void {
  const st = store.stats[key];
  if (!st) {
    store.stats[key] = { ms, n: 1 };
    return;
  }
  const n = st.n + 1;
  const alpha = Math.max(EMA_ALPHA, 1 / n); // média verdadeira até EMA assumir
  st.ms = st.ms + (ms - st.ms) * alpha;
  st.n = n;
}

/** Tenta criar o lockfile exclusivo; remove se órfão. Retorna o fd ou undefined. */
function acquireLock(): number | undefined {
  try {
    return fs.openSync(LOCK, 'wx'); // cria com exclusividade (falha se já existe)
  } catch {
    try {
      const st = fs.statSync(LOCK);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(LOCK, { force: true }); // lock órfão (processo morto): rouba
        return fs.openSync(LOCK, 'wx');
      }
    } catch {
      /* sumiu entre o stat e o rm: deixa o caller re-tentar */
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
  if (saveTimer) return; // já há um flush agendado (debounce)
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    flush();
  }, delay);
}

/** Persiste o buffer: lock → relê disco → mescla → grava atômico → atualiza cache. */
function flush(): void {
  if (pending.length === 0) return;
  const fd = acquireLock();
  if (fd == null) {
    scheduleSave(LOCK_RETRY_MS); // lock ocupado: re-tenta logo, sem perder o buffer
    return;
  }
  // Tira o lote agora; novas amostras durante o flush ficam p/ o próximo.
  const batch = pending.splice(0, pending.length);
  try {
    const base = readStore(); // estado fresco (inclui o que outras janelas gravaram)
    for (const s of batch) applySample(base, s.key, s.ms);
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(base, null, 2));
    fs.renameSync(tmp, FILE); // troca atômica (libuv usa replace-existing)
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
 * Médias só do escopo (modelo, effort, verbosity) pedido, com a chave reduzida ao
 * `type` puro — a webview consulta por tipo (tool:Read/assistant) sem conhecer o
 * escopo. Só entram chaves com >= MIN_SAMPLES amostras (confiáveis).
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

/** Enfileira uma amostra (ms) p/ (modelo, effort, verbosity, tipo); persiste debounced. */
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
