// Resilience of fetchAccountUsage: a transient failure must NOT drop the panel back to the
// local estimate — it retries and, failing that, reuses the last good reading.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

const OK_BODY = JSON.stringify({
  limits: [
    { kind: 'session', percent: 42, resets_at: '2026-08-10T03:20:00Z' },
    { kind: 'weekly_all', percent: 23, resets_at: '2026-08-14T06:00:00Z' },
  ],
});

// Each entry scripts one call: a 2xx body, or a failure to emit on the request.
type Step = { status: number; body: string } | { fail: 'error' | 'timeout' };
let steps: Step[] = [];
let calls = 0;

vi.mock('node:https', () => ({
  request: (_opts: unknown, cb: (res: any) => void) => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    const req = new EventEmitter() as any;
    req.end = () => {
      setImmediate(() => {
        if ('fail' in step) {
          if (step.fail === 'error') req.emit('error', new Error('ECONNRESET'));
          else req.emit('timeout');
          return;
        }
        const res = new EventEmitter() as any;
        res.statusCode = step.status;
        res.setEncoding = () => {};
        cb(res);
        res.emit('data', step.body);
        res.emit('end');
      });
    };
    req.destroy = () => {};
    return req;
  },
}));

vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: (p: any, enc?: any) =>
      String(p).includes('.credentials.json')
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } })
        : real.readFileSync(p, enc),
  };
});

const api = await import('../src/cli/UsageApi');

beforeEach(() => {
  api.resetUsageCache();
  steps = [];
  calls = 0;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => vi.useRealTimers());

describe('fetchAccountUsage', () => {
  it('lê os percentuais reais quando a API responde', async () => {
    steps = [{ status: 200, body: OK_BODY }];
    const u = await api.fetchAccountUsage(true);
    expect(u?.fiveHour?.usedPct).toBe(0.42);
    expect(u?.sevenDay?.usedPct).toBe(0.23);
    expect(u?.ageMs).toBeUndefined();
  });

  it('retenta uma vez em falha transitória e ainda entrega o dado real', async () => {
    steps = [{ fail: 'timeout' }, { status: 200, body: OK_BODY }];
    const u = await api.fetchAccountUsage(true);
    expect(calls).toBe(2);
    expect(u?.fiveHour?.usedPct).toBe(0.42);
  });

  it('não retenta em 401 (token expirado — retry não ajuda)', async () => {
    steps = [{ status: 401, body: 'expired' }];
    expect(await api.fetchAccountUsage(true)).toBeUndefined();
    expect(calls).toBe(1);
    expect(api.usageDiagnostics().lastError).toBe('HTTP 401');
  });

  it('reaproveita a última leitura real quando a chamada seguinte falha', async () => {
    steps = [{ status: 200, body: OK_BODY }];
    await api.fetchAccountUsage(true);
    steps = [{ fail: 'error' }];
    calls = 0;
    const u = await api.fetchAccountUsage(true);
    expect(u?.fiveHour?.usedPct).toBe(0.42); // real, não estimativa
    expect(u?.ageMs).toBeGreaterThanOrEqual(0);
    expect(api.usageDiagnostics().lastError).toContain('network');
  });

  it('descarta a leitura antiga depois da janela de tolerância', async () => {
    steps = [{ status: 200, body: OK_BODY }];
    await api.fetchAccountUsage(true);
    vi.setSystemTime(Date.now() + 20 * 60_000); // > STALE_OK_MS (15 min)
    steps = [{ fail: 'error' }];
    expect(await api.fetchAccountUsage(true)).toBeUndefined();
  });
});
