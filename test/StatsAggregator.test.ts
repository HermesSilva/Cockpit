import { describe, it, expect } from 'vitest';
import { StatsAggregator, normalizeModel, deriveContextLimit } from '../src/stats/StatsAggregator';

// Helpers to forge events in the shape the ingest expects.
const initEv = (model: string) => ({ type: 'system', subtype: 'init', model } as any);
const assistantEv = (
  model: string,
  u: Partial<{ input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number }>,
) => ({ type: 'assistant', message: { model, usage: u } } as any);

describe('StatsAggregator — consolidação de turno', () => {
  it('acumula tokens, conta o turno e segmenta por modelo', () => {
    const agg = new StatsAggregator(0);
    agg.beginTurn();
    agg.ingest(initEv('claude-opus-4-8'));
    agg.ingest(
      assistantEv('claude-opus-4-8', {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 0,
      }),
    );
    agg.endTurn();

    const s = agg.snapshot();
    expect(s.turnCount).toBe(1);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
    expect(s.cacheCreateTokens).toBe(200);
    expect(s.peakContextUsed).toBe(300); // input + create + read
    expect(s.perModel).toHaveLength(1);
    expect(s.perModel?.[0].turns).toBe(1);
    expect(s.activeMs).toBeGreaterThanOrEqual(0);
    expect(s.cacheResetCount).toBe(0); // the first turn is never a reset
    // Cache life: after a turn there is an expiry and the cache is alive.
    expect(s.cacheAlive).toBe(true);
    expect(s.cacheExpiresAt).toBeGreaterThan(Date.now());
    expect(s.cacheLifeMs).toBe(60 * 60_000);
  });
});

describe('StatsAggregator — robustez do parser', () => {
  it('normalizeModel colapsa sufixos [1m] repetidos, mantém limite 1M', () => {
    expect(normalizeModel('claude-opus-4-8[1m][1m]')).toBe('claude-opus-4-8[1m]');
    expect(normalizeModel('claude-opus-4-8[1M][1m]')).toBe('claude-opus-4-8[1M]');
    expect(normalizeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModel(undefined)).toBeUndefined();
    // The limit stays 1M even after the collapse.
    expect(deriveContextLimit(normalizeModel('claude-opus-4-8[1m][1m]'))).toBe(1_000_000);
  });

  it('o modelo de sessão é guardado já normalizado', () => {
    const agg = new StatsAggregator(0);
    agg.ingest(initEv('claude-opus-4-8[1m][1m]'));
    expect(agg.snapshot().model).toBe('claude-opus-4-8[1m]');
    expect(agg.snapshot().contextLimit).toBe(1_000_000);
  });

  it('usage malformado (NaN/negativo) não polui os totais', () => {
    const agg = new StatsAggregator(0);
    agg.beginTurn();
    agg.ingest(initEv('claude-opus-4-8'));
    agg.ingest(
      assistantEv('claude-opus-4-8', {
        input_tokens: NaN as any,
        output_tokens: -5,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: undefined as any,
      }),
    );
    agg.endTurn();
    const s = agg.snapshot();
    expect(s.inputTokens).toBe(0); // NaN -> 0
    expect(s.outputTokens).toBe(0); // negativo -> 0
    expect(s.cacheCreateTokens).toBe(100);
    expect(Number.isFinite(s.sessionCostUsd)).toBe(true);
  });
});

describe('StatsAggregator — log de negações (E5)', () => {
  it('registra negações com razão (mais recente primeiro) e sobrevive ao round-trip', () => {
    const agg = new StatsAggregator(0);
    agg.recordDecision('Bash', 'allow');
    agg.recordDecision('Write', 'deny', '  não mexa nesse arquivo  ');
    agg.recordDecision('Bash', 'deny'); // no reason

    const s = agg.snapshot();
    expect(s.recentDenials).toHaveLength(2);
    expect(s.recentDenials?.[0].tool).toBe('Bash'); // latest first
    expect(s.recentDenials?.[1]).toMatchObject({ tool: 'Write', reason: 'não mexa nesse arquivo' });
    // Per-tool acceptance still counts the denial.
    expect(s.toolAcceptance?.find((d) => d.tool === 'Bash')?.deny).toBe(1);

    const restored = new StatsAggregator(0);
    restored.hydrate(agg.serialize('sess-deny'));
    expect(restored.snapshot().recentDenials).toHaveLength(2);
  });
});

describe('StatsAggregator — persistência (serialize/hydrate)', () => {
  it('round-trip preserva acumuladores e contadores; reopen incrementa', () => {
    const agg = new StatsAggregator(0);
    agg.beginTurn();
    agg.ingest(initEv('claude-sonnet-4-6'));
    agg.ingest(
      assistantEv('claude-sonnet-4-6', {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5,
      }),
    );
    agg.endTurn();
    agg.setKeepCacheAlive(true);

    const persisted = agg.serialize('sess-1', '/proj/x');
    expect(persisted.sessionId).toBe('sess-1');
    expect(persisted.cwd).toBe('/proj/x'); // CacheKeeper retoma na pasta certa
    expect(persisted.keepCacheAlive).toBe(true);

    const restored = new StatsAggregator(0);
    restored.hydrate(persisted);
    restored.markReopen(); // reabriu o contexto

    const s = restored.snapshot();
    expect(s.turnCount).toBe(1);
    expect(s.inputTokens).toBe(10);
    expect(s.cacheReadTokens).toBe(5);
    expect(s.reopenCount).toBe(1);
    expect(s.contextUsed).toBe(15); // input 10 + create 0 + read 5 — barra restaurada
    expect(s.keepCacheAlive).toBe(true); // the checkbox survives the reopen
    expect(s.perModel?.[0].model).toBe('claude-sonnet-4-6');

    // The timeline survives the round-trip too.
    expect(restored.timelineSnapshot().timeline).toHaveLength(1);
  });
});
