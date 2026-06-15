// Médias de duração por tarefa, agora SEGMENTADAS por (modelo, effort, tipo) —
// pois a mesma tarefa (tool:Read, assistant, …) leva tempos bem diferentes
// conforme o modelo (opus lento, haiku rápido) e o effort. Arquivo GLOBAL em
// ~/.claude/tootega/ (serve qualquer projeto/aba/sessão). Calibra a velocidade do
// gauge de atividade ao tempo real de cada combinação.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const FILE = path.join(os.homedir(), '.claude', 'tootega', 'task-timings.json');
const VERSION = 2; // v2: chaves segmentadas por modelo+effort (v1 = só tipo)
const EMA_ALPHA = 0.3; // peso da amostra nova (0..1)
const MIN_MS = 150; // ignora ruído (reinícios quase instantâneos)
const MAX_MS = 30 * 60_000; // ignora outliers (processo travado)
const SEP = ' :: '; // separador legível: `<model> :: <effort> :: <type>`

interface Store {
  version: number;
  avg: Record<string, number>; // `<model> :: <effort> :: <type>` -> média EMA (ms)
}

let cache: Store | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Chave composta legível p/ o store. */
function keyOf(model: string, effort: string, type: string): string {
  return `${model}${SEP}${effort}${SEP}${type}`;
}

function load(): Store {
  if (cache) return cache;
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Só aproveita o arquivo se for da versão atual; v1 (chaves só por tipo) é
    // descartado — recalibra em poucos turnos com a nova segmentação.
    if (o && typeof o === 'object' && o.version === VERSION && o.avg && typeof o.avg === 'object') {
      cache = { version: VERSION, avg: o.avg };
      return cache;
    }
  } catch {
    /* arquivo ausente/corrompido: começa vazio */
  }
  cache = { version: VERSION, avg: {} };
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return; // já há um flush agendado (debounce)
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(load(), null, 2));
    } catch (e) {
      log(`task-timings save fail: ${String(e)}`);
    }
  }, 1500);
}

/**
 * Médias (EMA) só do escopo (modelo, effort) pedido, com a chave reduzida ao
 * `type` puro — assim a webview consulta por tipo (tool:Read/assistant) sem
 * conhecer modelo/effort. Vazio até haver amostras desse escopo.
 */
export function taskTimingsScoped(model: string, effort: string): Record<string, number> {
  const prefix = `${model}${SEP}${effort}${SEP}`;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(load().avg)) {
    if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
  }
  return out;
}

/** Registra uma amostra de duração (ms) p/ (modelo, effort, tipo) e persiste (debounced). */
export function recordTaskTiming(model: string, effort: string, type: string, ms: number): void {
  if (!model || !type || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return;
  const s = load();
  const key = keyOf(model, effort || 'default', type);
  const prev = s.avg[key];
  s.avg[key] = prev == null ? ms : prev * (1 - EMA_ALPHA) + ms * EMA_ALPHA;
  scheduleSave();
}
