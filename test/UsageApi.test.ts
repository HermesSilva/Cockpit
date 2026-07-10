// Parser do payload de /api/oauth/usage. Cobre o formato atual (`limits[]` com
// kind session/weekly_all/weekly_scoped) e o legado (campos fixos de topo).
import { describe, it, expect } from 'vitest';
import { parseUsage } from '../src/cli/UsageApi';

describe('parseUsage', () => {
  it('lê limits[] e nomeia a janela escopada pelo display_name do servidor', () => {
    const u = parseUsage({
      five_hour: { utilization: 70, resets_at: '2026-07-10T03:59:59Z' },
      seven_day: { utilization: 14, resets_at: '2026-07-10T05:59:59Z' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      limits: [
        { kind: 'session', percent: 70, resets_at: '2026-07-10T03:59:59Z' },
        { kind: 'weekly_all', percent: 14, resets_at: '2026-07-10T05:59:59Z' },
        {
          kind: 'weekly_scoped',
          percent: 5,
          resets_at: '2026-07-10T05:59:59Z',
          scope: { model: { id: null, display_name: 'Fable' } },
        },
      ],
    });
    expect(u.fiveHour?.usedPct).toBe(0.7);
    expect(u.sevenDay?.usedPct).toBe(0.14);
    expect(u.weeklyScoped).toEqual([
      { usedPct: 0.05, resetsAt: '2026-07-10T05:59:59Z', label: 'Fable' },
    ]);
  });

  it('cai nos campos legados quando limits[] não vem', () => {
    const u = parseUsage({
      five_hour: { utilization: 40, resets_at: '2026-07-10T03:59:59Z' },
      seven_day: { utilization: 10 },
      seven_day_sonnet: { utilization: 25 },
    });
    expect(u.fiveHour?.usedPct).toBe(0.4);
    expect(u.sevenDay?.usedPct).toBe(0.1);
    expect(u.weeklyScoped).toEqual([{ usedPct: 0.25, resetsAt: undefined, label: 'Sonnet' }]);
  });

  it('ignora janelas nulas e escopos sem nome', () => {
    const u = parseUsage({
      seven_day_opus: null,
      limits: [
        { kind: 'weekly_scoped', percent: 5, scope: { model: { display_name: null } } },
        { kind: 'session', percent: null },
      ],
    });
    expect(u.fiveHour).toBeUndefined();
    expect(u.weeklyScoped).toBeUndefined();
  });
});
