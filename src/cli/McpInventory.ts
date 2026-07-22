// Extracts, from the CLI's `system/init` event, the inventory of tools per MCP server.
// PURE logic (no VSCode/CLI) so it is testable and reusable in the UI: it takes the
// raw `tools[]` and `mcp_servers[]` lists from init and returns the MCP tools
// grouped per server, plus the native tools separately.
//
// Shape of the MCP tool names emitted by the CLI:
//   mcp__<server>__<tool>
// The `<server>` is a "sanitized" form of the server name: characters outside
// [A-Za-z0-9_-] become '_' (e.g. the ':' in a plugin id). Since the server name
// never contains '__' (only single '_'), the server↔tool separator is the
// FIRST '__' after the `mcp__` prefix. E.g.:
//   mcp__plugin_mssql-localdb-mcp_mssql-localdb__sql_execute_query
//        └────────── server ───────────────────┘  └──── tool ────┘

const MCP_PREFIX = 'mcp__';

export interface McpServerGroup {
  /** Server display name (from `mcp_servers[]` when it matches; otherwise the sanitized key). */
  name: string;
  /** Sanitized key used in the tool prefix (`mcp__<key>__…`). */
  key: string;
  /** Status reported by init (`connected`, `failed`, …). `undefined` when the server wasn't in init. */
  status?: string;
  /** Short tool names (without the `mcp__<server>__` prefix), in stable order. */
  tools: string[];
}

export interface McpInventory {
  /** MCP servers with their tools; includes servers with no tools (0 tools) coming from init. */
  servers: McpServerGroup[];
  /** Native agent tools (Read, Edit, Bash, …), without the `mcp__` prefix. */
  nativeTools: string[];
}

// --- `claude mcp list` -------------------------------------------------------
// init only knows servers the session CONNECTED: a `.mcp.json` server that is
// not approved yet (2.1.196) doesn't show up there — the CLI won't start it. `mcp list` is
// what reveals those ("⏸ Pending approval") and each one's command/URL. There is no
// `--json`: the output is text (confirmed on CLI 2.1.209) in these shapes:
//   <name>: <command>                        - <status>   (stdio)
//   <name>: <url> (HTTP|SSE)                 - <status>   (configured remote)
//   <name>:  (HTTP|SSE)                      - <status>   (remote WITHOUT a url → 2.1.208)
// where <status> = "✔ Connected" | "✗ Failed to connect" | "⏸ Pending approval …".
// The status glyph varies between versions (it was `√`, became `✔`) — that's why we match the
// WORD, never the symbol. Tolerant parsing: a line that doesn't match is ignored.

export type McpListStatus = 'connected' | 'failed' | 'pending' | 'unknown';

export interface McpListEntry {
  name: string;
  /** Command (stdio) or URL (http/sse), already WITHOUT the `(HTTP)`/`(SSE)` suffix. */
  target?: string;
  /** Declared remote transport ('HTTP' | 'SSE'). Absent = stdio. */
  transport?: string;
  /** Remote declared without a URL — CLI 2.1.208 labels it "not configured". */
  notConfigured?: boolean;
  status: McpListStatus;
}

const LIST_RE = /^(.+?):\s(.*?)\s+-\s+(.+)$/;
// Transport suffix the CLI appends to remote servers: "… (HTTP)" / "… (SSE)".
const TRANSPORT_RE = /^(.*?)\s*\(([A-Za-z]+)\)$/;

function listStatus(tail: string): McpListStatus {
  const s = tail.toLowerCase();
  if (s.includes('pending')) return 'pending';
  if (s.includes('fail') || s.includes('error')) return 'failed';
  if (s.includes('connected')) return 'connected';
  return 'unknown';
}

/** Turns the stdout of `claude mcp list` into entries. Pure logic (testable). */
export function parseMcpList(stdout: string): McpListEntry[] {
  const out: McpListEntry[] = [];
  for (const raw of (stdout ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = LIST_RE.exec(line);
    if (!m) continue; // cabeçalho ("Checking MCP server health…"), rodapé, ruído
    const name = m[1].trim();
    if (!name) continue;

    let target = m[2].trim();
    let transport: string | undefined;
    // Remote server: splits the URL from the "(HTTP)"/"(SSE)" suffix. stdio has no suffix.
    const tm = TRANSPORT_RE.exec(target);
    if (tm) {
      target = tm[1].trim();
      transport = tm[2].toUpperCase();
    }
    // Remote declared but without a URL: only the "(TYPE)" is left, empty target.
    const notConfigured = !!transport && !target;

    out.push({
      name,
      target: target || undefined,
      transport,
      notConfigured: notConfigured || undefined,
      status: listStatus(m[3]),
    });
  }
  return out;
}

/** Sanitizes a server name into the form used in the tool prefix. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Builds the MCP inventory from the raw lists of the `system/init` event.
 * Tolerant: missing/malformed entries are ignored, it never throws.
 */
export function parseMcpInventory(
  tools?: readonly string[],
  mcpServers?: ReadonlyArray<{ name?: string; status?: string }>,
): McpInventory {
  // Map sanitized-key → group. Insertion order preserved (Map).
  const groups = new Map<string, McpServerGroup>();

  // 1) Seeds with the servers announced in init (so servers with 0 tools
  //    show up, and we already capture display name + status).
  for (const s of mcpServers ?? []) {
    if (!s || typeof s.name !== 'string' || !s.name) continue;
    const key = sanitize(s.name);
    if (groups.has(key)) continue;
    groups.set(key, { name: s.name, key, status: s.status, tools: [] });
  }

  // 2) Distributes the MCP tools into the groups; separates the native ones.
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
      // `mcp__something` without a tool separator: treats the rest as a server with no named tool.
      const key = rest;
      if (!groups.has(key)) groups.set(key, { name: key, key, tools: [] });
      continue;
    }
    const key = rest.slice(0, sep);
    const tool = rest.slice(sep + 2);
    let g = groups.get(key);
    if (!g) {
      // Server not announced in init (or with a diverging name): creates it from the prefix.
      g = { name: key, key, tools: [] };
      groups.set(key, g);
    }
    if (tool && !g.tools.includes(tool)) g.tools.push(tool);
  }

  return { servers: [...groups.values()], nativeTools };
}
