// Extrai, do evento `system/init` do CLI, o inventário de tools por servidor MCP.
// Lógica PURA (sem VSCode/CLI) para ser testável e reusável na UI: recebe as
// listas cruas `tools[]` e `mcp_servers[]` do init e devolve os tools MCP
// agrupados por servidor, mais os tools nativos separados.
//
// Formato dos nomes de tool MCP emitidos pelo CLI:
//   mcp__<server>__<tool>
// O `<server>` é uma forma "sanitizada" do nome do servidor: caracteres que não
// sejam [A-Za-z0-9_-] viram '_' (ex.: os ':' do id de plugin). Como o nome do
// servidor nunca contém '__' (só '_' simples), o separador servidor↔tool é o
// PRIMEIRO '__' após o prefixo `mcp__`. Ex.:
//   mcp__plugin_mssql-localdb-mcp_mssql-localdb__sql_execute_query
//        └────────── server ───────────────────┘  └──── tool ────┘

const MCP_PREFIX = 'mcp__';

export interface McpServerGroup {
  /** Nome de exibição do servidor (do `mcp_servers[]` quando casa; senão a chave sanitizada). */
  name: string;
  /** Chave sanitizada usada no prefixo dos tools (`mcp__<key>__…`). */
  key: string;
  /** Status reportado pelo init (`connected`, `failed`, …). `undefined` se o servidor não veio no init. */
  status?: string;
  /** Nomes curtos dos tools (sem o prefixo `mcp__<server>__`), em ordem estável. */
  tools: string[];
}

export interface McpInventory {
  /** Servidores MCP com seus tools; inclui servidores sem tools (0 tools) vindos do init. */
  servers: McpServerGroup[];
  /** Tools nativos do agente (Read, Edit, Bash, …), sem prefixo `mcp__`. */
  nativeTools: string[];
}

/** Sanitiza um nome de servidor para a forma usada no prefixo do tool. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Constrói o inventário MCP a partir das listas cruas do evento `system/init`.
 * Tolerante: entradas ausentes/mal-formadas são ignoradas, nunca lança.
 */
export function parseMcpInventory(
  tools?: readonly string[],
  mcpServers?: ReadonlyArray<{ name?: string; status?: string }>,
): McpInventory {
  // Mapa chave-sanitizada → grupo. Ordem de inserção preservada (Map).
  const groups = new Map<string, McpServerGroup>();

  // 1) Semeia com os servidores anunciados no init (assim servidores com 0 tools
  //    aparecem, e já capturamos nome de exibição + status).
  for (const s of mcpServers ?? []) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    const key = sanitize(s.name);
    if (groups.has(key)) continue;
    groups.set(key, { name: s.name, key, status: s.status, tools: [] });
  }

  // 2) Distribui os tools MCP nos grupos; separa os nativos.
  const nativeTools: string[] = [];
  for (const full of tools ?? []) {
    if (typeof full !== 'string' || !full) continue;
    if (!full.startsWith(MCP_PREFIX)) {
      nativeTools.push(full);
      continue;
    }
    const rest = full.slice(MCP_PREFIX.length);
    const sep = rest.indexOf('__');
    if (sep < 0) {
      // `mcp__algo` sem separador de tool: trata o resto como servidor sem tool nomeado.
      const key = rest;
      if (!groups.has(key)) groups.set(key, { name: key, key, tools: [] });
      continue;
    }
    const key = rest.slice(0, sep);
    const tool = rest.slice(sep + 2);
    let g = groups.get(key);
    if (!g) {
      // Servidor não anunciado no init (ou nome divergente): cria pelo prefixo.
      g = { name: key, key, tools: [] };
      groups.set(key, g);
    }
    if (tool && !g.tools.includes(tool)) g.tools.push(tool);
  }

  return { servers: [...groups.values()], nativeTools };
}
