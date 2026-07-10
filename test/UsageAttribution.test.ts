// Atribuição do uso 7d: long context, subagentes, cache hit-rate e contexto
// injetado por ferramenta. Monta um transcript sintético em disco e varre.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeLocalUsage } from '../src/session/UsageAggregator';

const home = path.join(os.tmpdir(), `cockpit-attr-${process.pid}`);
const projects = path.join(home, '.claude', 'projects', 'proj');
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

/** Uma resposta assistant com usage + blocos opcionais. */
function assistant(o: {
  id: string;
  usage: Record<string, number>;
  content?: unknown[];
  sidechain?: boolean;
}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(3600_000),
    requestId: `req_${o.id}`,
    isSidechain: !!o.sidechain,
    message: { id: o.id, model: 'claude-opus-4-8', usage: o.usage, content: o.content ?? [] },
  });
}

function toolResult(id: string, text: string) {
  return JSON.stringify({
    type: 'user',
    timestamp: iso(3599_000),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  });
}

beforeAll(() => {
  fs.mkdirSync(projects, { recursive: true });
  const lines = [
    // Turno curto: contexto pequeno, chama uma tool de MCP.
    assistant({
      id: 'msg_a',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 1000 },
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__dase__query', input: {} }],
    }),
    toolResult('tu_1', 'x'.repeat(4000)), // ~1000 tokens
    // Turno com contexto > 150k: conta como long context (400 tokens novos).
    assistant({
      id: 'msg_b',
      usage: {
        input_tokens: 200,
        output_tokens: 200,
        cache_read_input_tokens: 200_000,
        cache_creation_input_tokens: 0,
      },
    }),
    // Subagente: 100 tokens novos.
    assistant({ id: 'msg_c', usage: { input_tokens: 50, output_tokens: 50 }, sidechain: true }),
  ];
  fs.writeFileSync(path.join(projects, 's.jsonl'), lines.join('\n'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe('computeLocalUsage — atribuição', () => {
  it('separa long context, subagentes, cache e contexto por ferramenta', async () => {
    const u = await computeLocalUsage(now);
    // novos: 200 (a) + 400 (b) + 100 (c) = 700
    expect(u.sevenDayTokens).toBe(700);
    expect(u.sevenDayCacheRead).toBe(201_000);
    const a = u.attribution;
    expect(a.longContextPct).toBeCloseTo(400 / 700, 5); // só msg_b
    expect(a.subagentPct).toBeCloseTo(100 / 700, 5); // só msg_c
    expect(a.cacheHitPct).toBe(1); // sem cache_creation
    expect(a.byTool).toEqual([{ key: 'mcp:dase', calls: 1, tokens: 1000 }]);
  });
});
