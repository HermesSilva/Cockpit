import { describe, it, expect } from 'vitest';
import { parseMcpInventory } from '../src/cli/McpInventory';

describe('parseMcpInventory', () => {
  it('agrupa tools MCP por servidor e separa os nativos', () => {
    const inv = parseMcpInventory(
      [
        'Read',
        'Bash',
        'mcp__github__create_issue',
        'mcp__github__list_prs',
        'mcp__sentry__get_error',
      ],
      [
        { name: 'github', status: 'connected' },
        { name: 'sentry', status: 'connected' },
      ],
    );
    expect(inv.nativeTools).toEqual(['Read', 'Bash']);
    const github = inv.servers.find((s) => s.name === 'github')!;
    expect(github.tools).toEqual(['create_issue', 'list_prs']);
    expect(github.status).toBe('connected');
    expect(inv.servers.find((s) => s.name === 'sentry')!.tools).toEqual(['get_error']);
  });

  it('casa o prefixo sanitizado com o nome de exibição (id de plugin com ":")', () => {
    const inv = parseMcpInventory(
      ['mcp__plugin_mssql-localdb-mcp_mssql-localdb__sql_execute_query'],
      [{ name: 'plugin:mssql-localdb-mcp:mssql-localdb', status: 'connected' }],
    );
    expect(inv.servers).toHaveLength(1);
    const s = inv.servers[0];
    expect(s.name).toBe('plugin:mssql-localdb-mcp:mssql-localdb'); // nome de exibição, não o sanitizado
    expect(s.tools).toEqual(['sql_execute_query']);
  });

  it('mantém servidores anunciados sem nenhum tool (0 tools)', () => {
    const inv = parseMcpInventory(['Read'], [{ name: 'idle', status: 'connected' }]);
    expect(inv.servers.find((s) => s.name === 'idle')!.tools).toEqual([]);
  });

  it('cria grupo a partir do prefixo quando o servidor não veio no init', () => {
    const inv = parseMcpInventory(['mcp__ghost__do_thing'], []);
    expect(inv.servers).toHaveLength(1);
    expect(inv.servers[0]).toMatchObject({ name: 'ghost', tools: ['do_thing'] });
    expect(inv.servers[0].status).toBeUndefined();
  });

  it('tolera nomes de tool com "_" simples no servidor e no tool', () => {
    const inv = parseMcpInventory(['mcp__my_server__do_a_thing'], []);
    // Primeiro "__" separa: server=my_server (via prefixo cru), tool=do_a_thing.
    expect(inv.servers[0].key).toBe('my_server');
    expect(inv.servers[0].tools).toEqual(['do_a_thing']);
  });

  it('tolera listas ausentes/vazias sem lançar', () => {
    expect(parseMcpInventory()).toEqual({ servers: [], nativeTools: [] });
    expect(parseMcpInventory(undefined, undefined)).toEqual({ servers: [], nativeTools: [] });
  });

  it('deduplica tools repetidos', () => {
    const inv = parseMcpInventory(['mcp__s__t', 'mcp__s__t'], []);
    expect(inv.servers[0].tools).toEqual(['t']);
  });
});
