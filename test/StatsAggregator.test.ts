import { describe, it, expect } from 'vitest';
import { StatsAggregator } from '../src/stats/StatsAggregator';

// Helpers para forjar eventos no shape que o ingest espera.
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
    expect(s.cacheResetCount).toBe(0); // 1º turno nunca é reset
    // Vida do cache: após um turno, há vencimento e o cache está vivo.
    expect(s.cacheAlive).toBe(true);
    expect(s.cacheExpiresAt).toBeGreaterThan(Date.now());
    expect(s.cacheLifeMs).toBe(60 * 60_000);
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
    expect(s.keepCacheAlive).toBe(true); // checkbox sobrevive ao reopen
    expect(s.perModel?.[0].model).toBe('claude-sonnet-4-6');

    // Timeline também sobrevive ao round-trip.
    expect(restored.timelineSnapshot().timeline).toHaveLength(1);
  });
});
