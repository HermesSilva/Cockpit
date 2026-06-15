// Médias de duração por tipo de tarefa (tool:Read, tool:Bash, assistant, …),
// num arquivo GLOBAL em ~/.claude/tootega/ (serve qualquer projeto/aba/sessão).
// Calibra a velocidade do gauge de atividade ao tempo real de cada tipo.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const FILE = path.join(os.homedir(), '.claude', 'tootega', 'task-timings.json');
const EMA_ALPHA = 0.3; // peso da amostra nova (0..1)
const MIN_MS = 150; // ignora ruído (reinícios quase instantâneos)
const MAX_MS = 30 * 60_000; // ignora outliers (processo travado)

interface Store {
  version: number;
  avg: Record<string, number>; // tipo -> média EMA (ms)
}

let cache: Store | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function load(): Store {
  if (cache) return cache;
  try {
    const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (o && typeof o === 'object' && o.avg && typeof o.avg === 'object') {
      cache = { version: 1, avg: o.avg };
      return cache;
    }
  } catch {
    /* arquivo ausente/corrompido: começa vazio */
  }
  cache = { version: 1, avg: {} };
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

/** Médias (EMA) de duração por tipo de tarefa, em ms. */
export function taskTimingsAll(): Record<string, number> {
  return { ...load().avg };
}

/** Registra uma amostra de duração (ms) por tipo e persiste (debounced). */
export function recordTaskTiming(type: string, ms: number): void {
  if (!type || !Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) return;
  const s = load();
  const prev = s.avg[type];
  s.avg[type] = prev == null ? ms : prev * (1 - EMA_ALPHA) + ms * EMA_ALPHA;
  scheduleSave();
}
