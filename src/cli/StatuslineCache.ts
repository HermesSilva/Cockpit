// Lê ~/.claude/.tootega-usage.json (gravado pelo wrapper de statusline) e
// extrai os limites reais da conta. Parser tolerante a variações de campo.
import * as fs from 'node:fs';
import { USAGE_CACHE } from './StatuslineInstaller';
import type { LimitWindow, ScopedBucket } from '../../shared/protocol';

export interface RealLimits {
  fiveHour?: LimitWindow; // janela da sessão atual
  sevenDay?: LimitWindow; // janela semanal de todos os modelos
  weeklyScoped?: ScopedBucket[]; // janelas semanais por modelo (quando existem)
  ageMs?: number; // idade do cache (now - ts); undefined se ts ausente
  raw?: unknown; // rate_limits cru, para depuração
}

export function readUsageCache(): RealLimits | undefined {
  let obj: any;
  try {
    obj = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8'));
  } catch {
    return undefined;
  }
  const ageMs = cacheAge(obj?.ts);
  const rl = obj?.rate_limits;
  if (!rl || typeof rl !== 'object') return { ageMs, raw: rl };
  const byKind = parseKinds(rl.limits);
  const fiveHour = byKind.fiveHour ?? parseWindow(rl.five_hour ?? rl.fiveHour ?? rl['5h']);
  const sevenDay =
    byKind.sevenDay ?? parseWindow(rl.seven_day ?? rl.sevenDay ?? rl['7d'] ?? rl.weekly);
  const weeklyScoped = byKind.weeklyScoped ?? legacyScoped(rl);
  if (!fiveHour && !sevenDay && !weeklyScoped) return { ageMs, raw: rl };
  return { fiveHour, sevenDay, weeklyScoped, ageMs, raw: rl };
}

/** Formato atual: `limits[]` com kind session|weekly_all|weekly_scoped + scope.model.display_name. */
function parseKinds(limits: unknown): Omit<RealLimits, 'ageMs' | 'raw'> {
  if (!Array.isArray(limits)) return {};
  const out: Omit<RealLimits, 'ageMs' | 'raw'> = {};
  const scoped: ScopedBucket[] = [];
  for (const l of limits) {
    const w = parseWindow(l);
    if (!w) continue;
    if (l.kind === 'session') out.fiveHour = w;
    else if (l.kind === 'weekly_all') out.sevenDay = w;
    else if (l.kind === 'weekly_scoped') {
      const label = l?.scope?.model?.display_name;
      if (typeof label === 'string' && label) scoped.push({ ...w, label });
    }
  }
  if (scoped.length) out.weeklyScoped = scoped;
  return out;
}

/** Legado: janelas semanais por modelo em campos fixos. */
function legacyScoped(rl: any): ScopedBucket[] | undefined {
  const scoped: ScopedBucket[] = [];
  for (const [label, ...keys] of [
    ['Opus', 'seven_day_opus', 'sevenDayOpus', 'weekly_opus', 'opus'],
    ['Sonnet', 'seven_day_sonnet', 'sevenDaySonnet', 'weekly_sonnet', 'sonnet'],
  ] as const) {
    for (const k of keys) {
      const w = parseWindow(rl[k]);
      if (w) {
        scoped.push({ ...w, label });
        break;
      }
    }
  }
  return scoped.length ? scoped : undefined;
}

/** Idade (ms) do cache a partir do campo `ts` (ISO). undefined se ausente/inválido. */
function cacheAge(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? undefined : Math.max(0, Date.now() - t);
}

function parseWindow(w: any): LimitWindow | undefined {
  if (!w || typeof w !== 'object') return undefined;
  let pct = firstNum([
    w.used_percentage, // campo oficial do statusline (rate_limits.*.used_percentage, 0..100)
    w.usedPercentage,
    w.used_pct,
    w.usedPct,
    w.utilization,
    w.percent,
    w.pct,
    w.used_percent,
    w.usage,
  ]);
  if (pct == null) return undefined;
  if (pct > 1.5) pct = pct / 100; // veio em 0..100
  const resetsAt = firstStr([w.resets_at, w.reset_at, w.resetsAt, w.reset]);
  return { usedPct: Math.max(0, Math.min(1, pct)), resetsAt };
}

function firstNum(vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === 'number' && Number.isFinite(v)) return v;
  return undefined;
}
function firstStr(vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) {
      // epoch (s ou ms) -> ISO
      const ms = v > 1e12 ? v : v * 1000;
      try {
        return new Date(ms).toISOString();
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
