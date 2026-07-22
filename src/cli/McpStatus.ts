// State of the MCP servers for the panel (X4). Joins the TWO sources the CLI
// offers, because neither is enough on its own:
//
//  1. the session's `system/init` event — brings the servers the session connected and,
//     via `tools[]`, WHICH TOOLS each one exposes (`mcp list` doesn't say that). Free,
//     it is already in the stream.
//  2. `claude mcp list` — reveals what init can't see: servers from `.mcp.json` that are
//     NOT approved yet (⏸ Pending approval, CLI 2.1.196), which the CLI won't even start, plus
//     each server's command/URL. Costs a spawn (health-check), so it only runs
//     when the user opens the panel.
//
// Never throws: a spawn failure/timeout returns only what init knew.
import { spawn } from 'node:child_process';
import type { McpServerInfo } from '../../shared/protocol';
import { parseMcpInventory, parseMcpList, type McpListEntry } from './McpInventory';
import { dlog } from '../util/logger';

const LIST_TIMEOUT_MS = 15_000; // health-check of a slow server; 8s isn't enough

/** Runs `claude mcp list` and returns the entries. Failure/timeout → []. */
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
 * Merges init + `mcp list` into a single inventory. Pure logic (testable).
 * Matched by exact name — init and `mcp list` use the same key (e.g.
 * `plugin:dase-mcp:dase`). The `mcp list` status WINS when present: it is what
 * distinguishes "pending approval" from "connected", and it is measured right now.
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
      // Only in `mcp list`: typically a server pending approval — the session
      // didn't start it, so there are no tools to show.
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
  // Pending and failed first (that's what needs user action), then by name.
  const rank = (s: string) => (s === 'pending' ? 0 : s === 'failed' ? 1 : 2);
  return [...byName.values()].sort(
    (a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name),
  );
}

/** init status (`connected` | `failed` | …) on the same scale as `mcp list`. */
function normalizeStatus(s?: string): McpServerInfo['status'] {
  const v = (s ?? '').toLowerCase();
  if (v === 'connected') return 'connected';
  if (v === 'failed' || v === 'error') return 'failed';
  if (v === 'pending' || v === 'needs-auth') return 'pending';
  return 'unknown';
}
