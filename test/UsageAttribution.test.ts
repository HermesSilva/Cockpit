// 7d usage attribution: long context, subagents, cache hit rate and context
// injected per tool. It builds a synthetic transcript on disk and scans it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeLocalUsage } from '../src/session/UsageAggregator';

const home = path.join(os.tmpdir(), `cockpit-attr-${process.pid}`);
const projects = path.join(home, '.claude', 'projects', 'proj');
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

/** An assistant response with usage + optional blocks. */
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
    // Short turn: small context, calls an MCP tool.
    assistant({
      id: 'msg_a',
      usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 1000 },
      content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__dase__query', input: {} }],
    }),
    toolResult('tu_1', 'x'.repeat(4000)), // ~1000 tokens
    // Turn with context > 150k: counts as long context (400 new tokens).
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
    expect(a.longContextPct).toBeCloseTo(400 / 700, 5); // msg_b only
    expect(a.subagentPct).toBeCloseTo(100 / 700, 5); // msg_c only
    expect(a.cacheHitPct).toBe(1); // no cache_creation
    expect(a.byTool).toEqual([{ key: 'mcp:dase', calls: 1, tokens: 1000 }]);
  });
});
