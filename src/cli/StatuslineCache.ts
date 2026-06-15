// Lê ~/.claude/.tootega-usage.json (gravado pelo wrapper de statusline) e
// extrai os limites reais da conta. Parser tolerante a variações de campo.
import * as fs from 'node:fs';
import { USAGE_CACHE } from './StatuslineInstaller';
import type { LimitWindow } from '../../shared/protocol';

export interface RealLimits {
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
  raw?: unknown; // rate_limits cru, para depuração
}

export function readUsageCache(): RealLimits | undefined {
  let obj: any;
  try {
    obj = JSON.parse(fs.readFileSync(USAGE_CACHE, 'utf8'));
  } catch {
    return undefined;
  }
  const rl = obj?.rate_limits;
  if (!rl || typeof rl !== 'object') return undefined;
  const fiveHour = parseWindow(rl.five_hour ?? rl.fiveHour ?? rl['5h']);
  const sevenDay = parseWindow(rl.seven_day ?? rl.sevenDay ?? rl['7d'] ?? rl.weekly);
  if (!fiveHour && !sevenDay) return { raw: rl };
  return { fiveHour, sevenDay, raw: rl };
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
