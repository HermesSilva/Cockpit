import { describe, it, expect } from 'vitest';
import { parseMcpList } from '../src/cli/McpInventory';
import { mergeMcpStatus } from '../src/cli/McpStatus';

// Saída real do `claude mcp list` (2.1.207), incluindo o cabeçalho de health-check.
const LIST_OUT = `Checking MCP server health…

plugin:dase-mcp:dase: node D:/Tootega/Source/DASE50/MCP/server/dase-mcp.cjs - √ Connected
plugin:mssql-localdb-mcp:mssql-localdb: D:/Tootega/Source/LocalDB-MCP/mssql.exe  - √ Connected
repo-tool: node ./scripts/mcp.js - ⏸ Pending approval
broken: node ./nope.js - ✗ Failed to connect
`;

describe('parseMcpList', () => {
  it('extrai nome, alvo e status; ignora cabeçalho e linhas vazias', () => {
    const rows = parseMcpList(LIST_OUT);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ name: 'plugin:dase-mcp:dase', status: 'connected' });
    expect(rows[2]).toMatchObject({ name: 'repo-tool', status: 'pending' });
    expect(rows[3]).toMatchObject({ name: 'broken', status: 'failed' });
  });

  it('preserva o alvo (comando ou URL) do servidor', () => {
    const rows = parseMcpList('api: https://mcp.example.com/sse - √ Connected');
    expect(rows[0].target).toBe('https://mcp.example.com/sse');
  });

  it('casa o status pela palavra, não pelo glyph (√ virou ✔ na 2.1.208)', () => {
    expect(parseMcpList('a: node x.js - ✔ Connected')[0].status).toBe('connected');
    expect(parseMcpList('a: node x.js - √ Connected')[0].status).toBe('connected');
    expect(parseMcpList('a: node x.js - ✗ Failed to connect')[0].status).toBe('failed');
  });

  it('separa o sufixo de transporte (HTTP/SSE) da URL', () => {
    const http = parseMcpList('withurl: https://mcp.example.com/api (HTTP) - ⏸ Pending approval')[0];
    expect(http).toMatchObject({ target: 'https://mcp.example.com/api', transport: 'HTTP' });
    expect(http.notConfigured).toBeUndefined();

    const sse = parseMcpList('s: https://s.example.com/sse (SSE) - ✔ Connected')[0];
    expect(sse).toMatchObject({ target: 'https://s.example.com/sse', transport: 'SSE' });
  });

  it('remoto sem URL vira notConfigured (2.1.208), sem alvo falso', () => {
    const row = parseMcpList('emptyurl:  (HTTP) - ⏸ Pending approval (run `claude` to approve)')[0];
    expect(row).toMatchObject({ name: 'emptyurl', transport: 'HTTP', notConfigured: true });
    expect(row.target).toBeUndefined();
  });

  it('stdio não tem sufixo de transporte', () => {
    const row = parseMcpList('local: node ./scripts/mcp.js - ✔ Connected')[0];
    expect(row.target).toBe('node ./scripts/mcp.js');
    expect(row.transport).toBeUndefined();
    expect(row.notConfigured).toBeUndefined();
  });

  it('entrada vazia/ruído não quebra', () => {
    expect(parseMcpList('')).toEqual([]);
    expect(parseMcpList('Checking MCP server health…')).toEqual([]);
  });
});

describe('mergeMcpStatus', () => {
  it('junta as tools do init com o status/alvo do mcp list', () => {
    const servers = mergeMcpStatus(
      ['Read', 'mcp__github__create_issue', 'mcp__github__list_prs'],
      [{ name: 'github', status: 'connected' }],
      parseMcpList('github: node ./gh.js - √ Connected'),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'github',
      status: 'connected',
      connected: true,
      target: 'node ./gh.js',
    });
    expect(servers[0].tools).toEqual(['create_issue', 'list_prs']);
  });

  it('inclui servidor pendente que o init nem viu (a sessão não o sobe)', () => {
    const servers = mergeMcpStatus(
      ['Read'],
      [],
      parseMcpList('repo-tool: node ./scripts/mcp.js - ⏸ Pending approval'),
    );
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'repo-tool', status: 'pending', connected: false });
    expect(servers[0].tools).toEqual([]);
  });

  it('propaga transport/notConfigured de um remoto sem URL ao card', () => {
    const servers = mergeMcpStatus([], [], parseMcpList('emptyurl:  (HTTP) - ⏸ Pending approval'));
    expect(servers[0]).toMatchObject({
      name: 'emptyurl',
      status: 'pending',
      transport: 'HTTP',
      notConfigured: true,
    });
    expect(servers[0].target).toBeUndefined();
  });

  it('o status do mcp list prevalece sobre o do init (é medido agora)', () => {
    const servers = mergeMcpStatus(
      ['mcp__api__ping'],
      [{ name: 'api', status: 'connected' }],
      parseMcpList('api: node ./api.js - ✗ Failed to connect'),
    );
    expect(servers[0]).toMatchObject({ status: 'failed', connected: false });
    expect(servers[0].tools).toEqual(['ping']); // tools do init continuam visíveis
  });

  it('ordena: pendentes e falhos primeiro (é o que pede ação)', () => {
    const servers = mergeMcpStatus(
      [],
      [],
      parseMcpList(
        ['zz-ok: a - √ Connected', 'aa-bad: b - ✗ Failed to connect', 'mm-wait: c - ⏸ Pending approval'].join('\n'),
      ),
    );
    expect(servers.map((s) => s.name)).toEqual(['mm-wait', 'aa-bad', 'zz-ok']);
  });

  it('sem mcp list (falhou/timeout): devolve o que o init sabia', () => {
    const servers = mergeMcpStatus(['mcp__api__ping'], [{ name: 'api', status: 'connected' }], []);
    expect(servers[0]).toMatchObject({ name: 'api', status: 'connected', connected: true });
  });
});
