// Estado dos servidores MCP para o painel (X4). Junta as DUAS fontes que o CLI
// oferece, porque nenhuma sozinha basta:
//
//  1. evento `system/init` da sessão — traz os servidores que a sessão conectou e,
//     via `tools[]`, QUAIS TOOLS cada um expõe (o `mcp list` não diz isso). De graça,
//     já está no stream.
//  2. `claude mcp list` — revela o que o init não vê: servidores de `.mcp.json` ainda
//     NÃO aprovados (⏸ Pending approval, CLI 2.1.196), que o CLI nem sobe, mais o
//     comando/URL de cada servidor. Custa um spawn (health-check), então só roda
//     quando o usuário abre o painel.
//
// Nunca lança: falha/timeout do spawn devolve só o que o init sabia.
import { spawn } from 'node:child_process';
import type { McpServerInfo } from '../../shared/protocol';
import { parseMcpInventory, parseMcpList, type McpListEntry } from './McpInventory';
import { dlog } from '../util/logger';

const LIST_TIMEOUT_MS = 15_000; // health-check de servidor lento; 8s não basta

/** Roda `claude mcp list` e devolve as entradas. Falha/timeout → []. */
export function fetchMcpList(claudePath: string): Promise<McpListEntry[]> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: McpListEntry[]) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const useShell = process.platform === 'win32';
      const exe =
        useShell && /\s/.test(claudePath) && !claudePath.startsWith('"')
          ? `"${claudePath}"`
          : claudePath;
      const p = spawn(exe, ['mcp', 'list'], { shell: useShell, windowsHide: true });
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* noop */
        }
        dlog('mcp', 'mcp list: timeout');
        finish([]);
      }, LIST_TIMEOUT_MS);
      let out = '';
      p.stdout?.setEncoding('utf8');
      p.stdout?.on('data', (c: string) => (out += c));
      p.on('error', (e) => {
        clearTimeout(timer);
        dlog('mcp', `mcp list: ${String(e)}`);
        finish([]);
      });
      p.on('close', () => {
        clearTimeout(timer);
        finish(parseMcpList(out));
      });
    } catch (e) {
      dlog('mcp', `mcp list: ${String(e)}`);
      finish([]);
    }
  });
}

/**
 * Funde init + `mcp list` num único inventário. Lógica pura (testável).
 * Casamento por nome exato — init e `mcp list` usam a mesma chave (ex.:
 * `plugin:dase-mcp:dase`). O status do `mcp list` PREVALECE quando existe: é ele
 * que distingue "pendente de aprovação" de "conectado", e é medido agora.
 */
export function mergeMcpStatus(
  tools: readonly string[] | undefined,
  initServers: ReadonlyArray<{ name?: string; status?: string }> | undefined,
  list: readonly McpListEntry[],
): McpServerInfo[] {
  const inv = parseMcpInventory(tools, initServers);
  const byName = new Map<string, McpServerInfo>();

  for (const g of inv.servers) {
    byName.set(g.name, {
      name: g.name,
      status: normalizeStatus(g.status),
      tools: g.tools,
      connected: g.status === 'connected',
    });
  }
  for (const e of list) {
    const cur = byName.get(e.name);
    if (cur) {
      cur.status = e.status;
      cur.target = e.target;
      cur.transport = e.transport;
      cur.notConfigured = e.notConfigured;
      cur.connected = e.status === 'connected';
    } else {
      // Só no `mcp list`: tipicamente um servidor pendente de aprovação — a sessão
      // não o subiu, então não há tools a mostrar.
      byName.set(e.name, {
        name: e.name,
        status: e.status,
        target: e.target,
        transport: e.transport,
        notConfigured: e.notConfigured,
        tools: [],
        connected: e.status === 'connected',
      });
    }
  }
  // Pendentes e falhos primeiro (é o que pede ação do usuário), depois por nome.
  const rank = (s: string) => (s === 'pending' ? 0 : s === 'failed' ? 1 : 2);
  return [...byName.values()].sort(
    (a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name),
  );
}

/** Status do init (`connected` | `failed` | …) na mesma escala do `mcp list`. */
function normalizeStatus(s?: string): McpServerInfo['status'] {
  const v = (s ?? '').toLowerCase();
  if (v === 'connected') return 'connected';
  if (v === 'failed' || v === 'error') return 'failed';
  if (v === 'pending' || v === 'needs-auth') return 'pending';
  return 'unknown';
}
