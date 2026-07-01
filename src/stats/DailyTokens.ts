// Contador GLOBAL de tokens (enviado / recebido / total), agregado por dia.
// Fonte: os transcripts em ~/.claude/projects/**/*.jsonl — escritos pelo CLI e
// COMPARTILHADOS por todos os contextos e por todas as instâncias do VSCode na
// máquina. Por isso o número é naturalmente "global": qualquer janela/contexto
// que tenha rodado um turno deixou rastro aqui.
//
// "enviado"  = input + cache_read + cache_creation (tudo que foi mandado ao modelo)
// "recebido" = output
// "total"    = enviado + recebido
//
// Performance: varrer TODO o histórico a cada abertura seria caro. Mantemos um
// rollup incremental em ~/.claude/tootega/tokens-rollup.json: por arquivo guarda
// mtime+size e o mapa dia→{s,r}; só re-lê o arquivo se ele mudou. O rollup é um
// CACHE derivado (a verdade são os .jsonl): escrita atômica, last-write-wins
// entre instâncias, sem necessidade de lock.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';
import type { Usage } from '../../shared/events';

/** Tokens de um único dia (chave local YYYY-MM-DD). */
export interface DailyTokens {
  date: string; // YYYY-MM-DD no fuso local
  sent: number; // input + cache_read + cache_creation
  received: number; // output
}

/** Totais globais (all-time) + recorte por dia (mais recente primeiro). */
export interface TokenTotals {
  sent: number;
  received: number;
  total: number;
  days: DailyTokens[]; // limitado p/ exibição; total é all-time
}

const ROLLUP_VERSION = 1;
const ROLLUP = path.join(os.homedir(), '.claude', 'tootega', 'tokens-rollup.json');

/** Mapa dia→{s:sent, r:received} de UM arquivo. */
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

/** YYYY-MM-DD no fuso LOCAL (não UTC — "por dia" é o dia do usuário). */
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
    /* ausente/corrompido/versão antiga: recomeça do zero */
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

/** Lê um .jsonl e devolve o mapa dia→{s,r} das linhas assistant com usage. */
function parseFile(content: string): FileDays {
  const days: FileDays = {};
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
 * Agrega tokens por dia em TODA a máquina (global). `maxDays` limita só o recorte
 * exibido; os totais sent/received/total são all-time.
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
        // Inalterado (mesmo mtime+size): reaproveita o agregado, não re-lê.
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          next.files[full] = cached;
          continue;
        }
        const content = await fs.promises.readFile(full, 'utf8');
        next.files[full] = { mtimeMs: st.mtimeMs, size: st.size, days: parseFile(content) };
      } catch {
        /* arquivo problemático: ignora (entradas órfãs caem fora do next) */
      }
    }
  }

  saveRollup(next);

  // Soma todos os arquivos → mapa dia→{s,r} global.
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
