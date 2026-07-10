import { describe, it, expect } from 'vitest';
import { OtelReceiver } from '../src/cli/OtelReceiver';

// Payload OTLP/JSON mínimo (ExportMetricsServiceRequest) com as métricas que o
// Claude Code emite. asInt vem como string no JSON OTLP — o parser converte.
function metric(name: string, points: { value: number | string; attrs?: Record<string, string> }[]) {
  return {
    name,
    sum: {
      dataPoints: points.map((p) => ({
        asInt: p.value,
        attributes: Object.entries(p.attrs ?? {}).map(([key, v]) => ({
          key,
          value: { stringValue: v },
        })),
      })),
    },
  };
}
function body(metrics: any[]) {
  return { resourceMetrics: [{ scopeMetrics: [{ metrics }] }] };
}

describe('OtelReceiver — ingestMetrics', () => {
  it('agrega LOC (added/removed) e separa por modelo', () => {
    const r = new OtelReceiver();
    r.ingest(
      body([
        metric('claude_code.lines_of_code.count', [
          { value: '120', attrs: { type: 'added', model: 'claude-opus-4-8[1m]' } },
          { value: 30, attrs: { type: 'removed', model: 'claude-opus-4-8[1m]' } },
          { value: 50, attrs: { type: 'added', model: 'claude-sonnet-4-6' } },
        ]),
      ]),
    );
    const s = r.stats();
    expect(s.linesAdded).toBe(170);
    expect(s.linesRemoved).toBe(30);
    expect(s.locByModel).toEqual([
      { key: 'claude-opus-4-8[1m]', usd: 0, tokens: 120, cacheRead: 0 },
      { key: 'claude-sonnet-4-6', usd: 0, tokens: 50, cacheRead: 0 },
    ]);
  });

  it('agrega custo REAL por modelo (cost.usage, double) + tokens reais', () => {
    const r = new OtelReceiver();
    r.ingest(
      body([
        {
          name: 'claude_code.cost.usage',
          sum: {
            dataPoints: [
              { asDouble: 0.42, attributes: [{ key: 'model', value: { stringValue: 'claude-opus-4-8' } }] },
              { asDouble: 0.08, attributes: [{ key: 'model', value: { stringValue: 'claude-sonnet-4-6' } }] },
            ],
          },
        },
        metric('claude_code.token.usage', [
          { value: 1500, attrs: { model: 'claude-opus-4-8', type: 'input' } },
        ]),
      ]),
    );
    const s = r.stats();
    expect(s.costByModel?.[0]).toEqual({
      key: 'claude-opus-4-8',
      usd: 0.42,
      tokens: 1500,
      cacheRead: 0,
    });
    expect(s.costByModel?.[1]).toMatchObject({ key: 'claude-sonnet-4-6', usd: 0.08 });
  });

  it('agrega sessões, commits, PRs e decisões de edição', () => {
    const r = new OtelReceiver();
    r.ingest(
      body([
        metric('claude_code.session.count', [{ value: 3 }]),
        metric('claude_code.commit.count', [{ value: 2 }]),
        metric('claude_code.pull_request.count', [{ value: 1 }]),
        metric('claude_code.code_edit_tool.decision', [
          { value: 5, attrs: { decision: 'accept', tool_name: 'Edit' } },
          { value: 2, attrs: { decision: 'reject', tool_name: 'Edit' } },
        ]),
      ]),
    );
    const s = r.stats();
    expect(s.sessionCount).toBe(3);
    expect(s.commitCount).toBe(2);
    expect(s.prCount).toBe(1);
    expect(s.toolDecisions).toEqual([{ tool: 'Edit', accept: 5, reject: 2 }]);
  });

  it('tolera payload malformado sem lançar', () => {
    const r = new OtelReceiver();
    expect(() => r.ingest(null)).not.toThrow();
    expect(() => r.ingest({})).not.toThrow();
    expect(() => r.ingest({ resourceMetrics: 'nope' })).not.toThrow();
    expect(() => r.ingest({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'x' }] }] }] })).not.toThrow();
    const s = r.stats();
    expect(s.linesAdded).toBe(0);
    expect(s.enabled).toBe(false); // nunca chamou start()
  });
});
