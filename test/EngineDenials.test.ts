import { describe, it, expect } from 'vitest';
import { StatsAggregator } from '../src/stats/StatsAggregator';

// Denial decided by the ENGINE (auto mode / missing permission). Real CLI shape
// 2.1.207: the `result` lists `permission_denials[]` (tool + input, no reason) and the
// reason comes in the error `tool_result` with the same tool_use_id.
const toolErrorEv = (id: string, text: string) =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }] },
  }) as any;

const resultEv = (denials: unknown[]) =>
  ({ type: 'result', subtype: 'success', permission_denials: denials }) as any;

const DENIAL_TEXT =
  "Claude requested permissions to write to D:\\repo\\x.txt, but you haven't granted it yet.";

describe('StatsAggregator — negações do engine (auto mode)', () => {
  it('registra a negação do `result` com o motivo vindo do tool_result de erro', () => {
    const agg = new StatsAggregator(0);
    agg.ingest(toolErrorEv('toolu_1', DENIAL_TEXT));
    agg.ingest(resultEv([{ tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: {} }]));

    const s = agg.snapshot();
    expect(s.recentDenials).toHaveLength(1);
    expect(s.recentDenials?.[0]).toMatchObject({
      tool: 'Write',
      source: 'engine',
      reason: DENIAL_TEXT,
    });
    // It also counts as a rejection in the per-tool acceptance.
    expect(s.toolAcceptance?.find((d) => d.tool === 'Write')?.deny).toBe(1);
  });

  it('não duplica quando o mesmo tool_use_id volta em outro `result`', () => {
    const agg = new StatsAggregator(0);
    const denial = [{ tool_name: 'Bash', tool_use_id: 'toolu_2' }];
    agg.ingest(resultEv(denial));
    agg.ingest(resultEv(denial)); // turno seguinte repete a lista

    const s = agg.snapshot();
    expect(s.recentDenials).toHaveLength(1);
    expect(s.toolAcceptance?.find((d) => d.tool === 'Bash')?.deny).toBe(1);
  });

  it('distingue negação do usuário (modal) da negação do engine', () => {
    const agg = new StatsAggregator(0);
    agg.recordDecision('Edit', 'deny', 'não quero');
    agg.ingest(toolErrorEv('toolu_3', DENIAL_TEXT));
    agg.ingest(resultEv([{ tool_name: 'Write', tool_use_id: 'toolu_3' }]));

    const s = agg.snapshot();
    // Most recent first: the engine one came later.
    expect(s.recentDenials?.map((d) => d.source)).toEqual(['engine', 'user']);
  });

  it('erro comum de tool (não negado) nunca vira negação', () => {
    const agg = new StatsAggregator(0);
    agg.ingest(toolErrorEv('toolu_4', 'File not found'));
    agg.ingest(resultEv([])); // o `result` não lista denial nenhuma

    expect(agg.snapshot().recentDenials).toBeUndefined();
  });

  it('negação sem tool_result correspondente entra sem motivo', () => {
    const agg = new StatsAggregator(0);
    agg.ingest(resultEv([{ tool_name: 'Bash', tool_use_id: 'toolu_5' }]));

    const s = agg.snapshot();
    expect(s.recentDenials?.[0]).toMatchObject({ tool: 'Bash', source: 'engine' });
    expect(s.recentDenials?.[0].reason).toBeUndefined();
  });

  it('`permission_denials` ausente ou malformado é ignorado', () => {
    const agg = new StatsAggregator(0);
    agg.ingest({ type: 'result', subtype: 'success' } as any);
    agg.ingest(resultEv(undefined as any));
    expect(agg.snapshot().recentDenials).toBeUndefined();
  });
});
