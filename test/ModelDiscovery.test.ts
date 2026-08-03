// Parser and picker rules of /v1/models. This is the ONLY source of the model list —
// there is no curated list in the extension — so the shape and the ordering are pinned here.
import { describe, it, expect } from 'vitest';
import { parseModels, pickerIds } from '../src/cli/ModelDiscovery';

// Trimmed to the fields the picker consumes (the real payload also carries `capabilities`).
const payload = {
  data: [
    {
      type: 'model',
      id: 'claude-opus-5',
      display_name: 'Claude Opus 5',
      created_at: '2026-07-24T00:00:00Z',
      max_input_tokens: 1_000_000,
    },
    {
      type: 'model',
      id: 'claude-opus-4-8',
      display_name: 'Claude Opus 4.8',
      created_at: '2026-05-28T00:00:00Z',
      max_input_tokens: 1_000_000,
    },
    {
      type: 'model',
      id: 'claude-haiku-4-5-20251001',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-15T00:00:00Z',
      max_input_tokens: 200_000,
    },
  ],
};

describe('parseModels', () => {
  it('lê id, display_name, created_at e max_input_tokens', () => {
    expect(parseModels(payload)[0]).toEqual({
      id: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      createdAt: '2026-07-24T00:00:00Z',
      contextTokens: 1_000_000,
    });
  });

  it('descarta entrada sem id e tolera metadados ausentes', () => {
    const models = parseModels({
      data: [{ type: 'model' }, { id: 'claude-x' }, { id: '' }],
    });
    expect(models).toEqual([
      { id: 'claude-x', contextTokens: undefined, displayName: undefined, createdAt: undefined },
    ]);
  });

  it('corpo inesperado vira lista vazia (nunca quebra o picker)', () => {
    expect(parseModels({})).toEqual([]);
    expect(parseModels(null)).toEqual([]);
    expect(parseModels({ data: 'nope' })).toEqual([]);
  });
});

describe('pickerIds', () => {
  it('ordena do mais novo p/ o mais antigo e sufixa [1m] só nos de janela 1M', () => {
    expect(pickerIds(parseModels(payload))).toEqual([
      'claude-opus-5[1m]',
      'claude-opus-4-8[1m]',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('sem created_at, mantém a ordem em que a API devolveu', () => {
    const ids = pickerIds([{ id: 'a' }, { id: 'b' }]);
    expect(ids).toEqual(['a', 'b']);
  });
});
