import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadTootegaTranscript, tootegaSessionsDir } from '../src/cli/TootegaTranscript';

// The shape here is what the agent really writes (tools/agent/agent.c,
// save_history): the OpenAI message list it sends to the server.
const TRANSCRIPT = [
  { role: 'system', content: 'Voce e o Tootega, um agente...' },
  { role: 'user', content: 'O que existe nesta pasta?' },
  {
    role: 'assistant',
    content: '<tool_call>Bash<arg_key>command</arg_key><arg_value>dir /b</arg_value></tool_call>',
    tool_calls: [
      { id: 'call_3_0', type: 'function', function: { name: 'Bash', arguments: '{"command":"dir /b"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_3_0', content: 'src\nREADME.md' },
  { role: 'assistant', content: 'A pasta tem `src` e o `README.md`.' },
];

const ID = 'vitest-transcript';
const FILE = path.join(tootegaSessionsDir(), `${ID}.json`);

describe('transcricao do agente Tootega', () => {
  beforeAll(() => {
    fs.mkdirSync(tootegaSessionsDir(), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(TRANSCRIPT), 'utf8');
  });
  afterAll(() => {
    try {
      fs.unlinkSync(FILE);
    } catch {
      /* noop */
    }
  });

  it('nao mostra o prompt de sistema', () => {
    const items = loadTootegaTranscript(ID);
    expect(items.some((i) => i.kind === 'user' && i.text.includes('Voce e o Tootega'))).toBe(false);
  });

  it('preserva a ordem da conversa', () => {
    expect(loadTootegaTranscript(ID).map((i) => i.kind)).toEqual([
      'user',
      'tool',
      'assistant',
    ]);
  });

  it('a chamada vira card com input parseado', () => {
    const tool = loadTootegaTranscript(ID).find((i) => i.kind === 'tool');
    expect(tool).toMatchObject({ id: 'call_3_0', name: 'Bash', input: { command: 'dir /b' } });
  });

  it('o resultado entra NO card que o pediu, nao como item solto', () => {
    const items = loadTootegaTranscript(ID);
    const tool = items.find((i) => i.kind === 'tool') as Extract<
      ReturnType<typeof loadTootegaTranscript>[number],
      { kind: 'tool' }
    >;
    expect(tool.result).toBe('src\nREADME.md');
  });

  it('turno que so chamou ferramenta nao vira bolha com marcacao crua', () => {
    const texts = loadTootegaTranscript(ID)
      .filter((i) => i.kind === 'assistant')
      .map((i) => (i as { text: string }).text);
    expect(texts).toEqual(['A pasta tem `src` e o `README.md`.']);
  });

  it('sessao sem transcricao devolve lista vazia, nao estoura', () => {
    expect(loadTootegaTranscript('nao-existe-mesmo')).toEqual([]);
  });
});
