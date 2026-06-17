// Gerência de plugins via CLI oficial (`claude plugin …`). Lista (instalados +
// disponíveis nos marketplaces), instala, remove, habilita/desabilita, atualiza;
// e gerencia marketplaces (add/remove). Tudo é o canal CLI — só surface na UI.
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ask } from './AiClient';
import { log } from '../util/logger';
import type { PluginsData } from '../../shared/protocol';

const URL_CACHE = path.join(os.homedir(), '.claude', 'tootega', 'plugin-urls.json');

export type PluginAction =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'update'
  | 'marketAdd'
  | 'marketRemove';

/** No Windows com shell, envolve o caminho em aspas se tiver espaços. */
function shellSafe(p: string, useShell: boolean): string {
  if (useShell && /\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}

/** Roda `claude <args>` e devolve { code, out, err }. Tolerante a timeout. */
function run(
  claudePath: string,
  args: string[],
  timeoutMs = 90_000,
): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32';
    let out = '';
    let err = '';
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(shellSafe(claudePath, useShell), args, {
        shell: useShell,
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e) });
      return;
    }
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch {
        /* noop */
      }
      resolve({ code: -1, out, err: err || 'timeout' });
    }, timeoutMs);
    p.stdout?.setEncoding('utf8');
    p.stderr?.setEncoding('utf8');
    p.stdout?.on('data', (c) => (out += c));
    p.stderr?.on('data', (c) => (err += c));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e) });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, out, err });
    });
  });
}

/** Extrai o 1º JSON (objeto ou array) da saída, tolerante a ruído antes/depois. */
function parseJson<T>(s: string): T | undefined {
  const a = s.indexOf('{');
  const b = s.indexOf('[');
  const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (start < 0) return undefined;
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  const end = s.lastIndexOf(close);
  if (end < start) return undefined;
  try {
    return JSON.parse(s.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

interface RawList {
  installed?: Array<{
    id?: string;
    version?: string;
    scope?: string;
    enabled?: boolean;
    installPath?: string;
  }>;
  available?: Array<{
    pluginId?: string;
    name?: string;
    description?: string;
    marketplaceName?: string;
    installCount?: number;
    source?: unknown; // objeto {url,path,ref} OU string (caminho no repo do marketplace)
  }>;
}

/** URL do repositório de um marketplace (p/ plugins sem source.url próprio). */
function marketUrl(m?: { source?: string; repo?: string }): string | undefined {
  if (!m || !m.repo) return undefined;
  if (/^https?:\/\//.test(m.repo)) return m.repo.replace(/\.git$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(m.repo)) return `https://github.com/${m.repo}`; // owner/name
  return undefined;
}

/** Resolve a URL de um plugin disponível (source próprio ou repo do marketplace). */
function availableUrl(source: unknown, marketRepoUrl?: string): string | undefined {
  if (source && typeof source === 'object') {
    const s = source as { url?: string; path?: string; ref?: string };
    const url = typeof s.url === 'string' ? s.url.replace(/\.git$/, '') : undefined;
    if (url && typeof s.path === 'string' && s.path) {
      const ref = typeof s.ref === 'string' && s.ref ? s.ref : 'HEAD';
      return `${url}/tree/${ref}/${s.path.replace(/^\.?\//, '')}`;
    }
    if (url) return url;
  }
  // source string = caminho relativo no monorepo do marketplace → cai pro repo dele.
  return marketRepoUrl;
}

/** Lê descrição + URL do manifest plugin.json de um plugin instalado. */
function readManifest(installPath?: string): { description?: string; url?: string } {
  if (!installPath) return {};
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'),
    );
    const repo = j.repository;
    const url =
      (typeof j.homepage === 'string' && j.homepage) ||
      (typeof repo === 'string' && repo) ||
      (repo && typeof repo.url === 'string' && repo.url) ||
      (j.author && typeof j.author.url === 'string' && j.author.url) ||
      undefined;
    return {
      description: typeof j.description === 'string' ? j.description : undefined,
      url: url ? String(url).replace(/^git\+/, '').replace(/\.git$/, '') : undefined,
    };
  } catch {
    return {};
  }
}

/** Quantos arquivos/dirs há numa subpasta (componentes do plugin). */
function countDir(base: string, sub: string): number {
  try {
    return fs.readdirSync(path.join(base, sub)).filter((f) => !f.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/** Tipo do plugin pelos componentes no installPath. Vazio se desconhecido. */
function componentKind(installPath?: string): string | undefined {
  if (!installPath) return undefined;
  const present: string[] = [];
  if (countDir(installPath, 'skills') > 0) present.push('skills');
  if (countDir(installPath, 'agents') > 0) present.push('agents');
  if (countDir(installPath, 'commands') > 0) present.push('commands');
  // hooks/mcp podem vir do manifest OU de pastas.
  let mcp = countDir(installPath, 'mcp-servers') > 0 || countDir(installPath, '.mcp') > 0;
  let hooks = countDir(installPath, 'hooks') > 0;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'));
    if (j.mcpServers && Object.keys(j.mcpServers).length) mcp = true;
    if (j.hooks && Object.keys(j.hooks).length) hooks = true;
  } catch {
    /* sem manifest legível */
  }
  if (mcp) present.push('mcp');
  if (hooks) present.push('hooks');
  if (present.length === 0) return undefined;
  // Um componente "de verdade" (mcp/commands/agents) domina hooks/skills.
  const strong = present.filter((p) => p !== 'hooks');
  if (strong.length > 1) return 'mixed';
  if (strong.length === 1) return strong[0];
  return present[0]; // só hooks
}
interface RawMarket {
  name?: string;
  source?: string;
  repo?: string;
}

// --- Cache de metadados (url + tipo) resolvidos pelo Haiku, em ~/.claude/tootega ---
const KINDS = ['skills', 'agents', 'commands', 'mcp', 'hooks', 'mixed'];
interface MetaEntry {
  url?: string;
  kind?: string;
}
interface MetaCache {
  version: number;
  meta: Record<string, MetaEntry>;
}
function loadMetaCache(): MetaCache {
  try {
    const o = JSON.parse(fs.readFileSync(URL_CACHE, 'utf8'));
    if (o && o.meta && typeof o.meta === 'object') return { version: 2, meta: o.meta };
    // Migra formato antigo { urls: {id:url} }.
    if (o && o.urls && typeof o.urls === 'object') {
      const meta: Record<string, MetaEntry> = {};
      for (const [k, v] of Object.entries(o.urls)) if (typeof v === 'string') meta[k] = { url: v };
      return { version: 2, meta };
    }
  } catch {
    /* ausente/corrompido */
  }
  return { version: 2, meta: {} };
}
function saveMetaCache(c: MetaCache): void {
  try {
    fs.mkdirSync(path.dirname(URL_CACHE), { recursive: true });
    fs.writeFileSync(URL_CACHE, JSON.stringify(c, null, 2));
  } catch (e) {
    log(`[plugin] meta cache save fail: ${String(e)}`);
  }
}

/**
 * Pede ao Haiku a URL canônica + o TIPO de cada plugin. Cacheado em
 * ~/.claude/tootega. `force` re-consulta tudo; senão só os que faltam.
 * O tipo dos INSTALADOS é calculado dos componentes (preciso) e sobrepõe.
 */
async function resolveMeta(data: PluginsData, force: boolean): Promise<void> {
  const cache = loadMetaCache();
  const cand = new Map<string, { name: string; market?: string; repo?: string; desc?: string }>();
  for (const a of data.available)
    cand.set(a.pluginId, { name: a.name, market: a.marketplaceName, repo: a.url, desc: a.description });
  for (const i of data.installed)
    if (!cand.has(i.id)) cand.set(i.id, { name: i.id.split('@')[0], repo: i.url, desc: i.description });

  const need = [...cand.keys()].filter((id) => force || !cache.meta[id]?.url || !cache.meta[id]?.kind);
  if (need.length) {
    const chunks: string[][] = [];
    for (let i = 0; i < need.length; i += 50) chunks.push(need.slice(i, i + 50));
    const results = await Promise.all(
      chunks.map((chunk) => {
        const lines = chunk.map((id) => {
          const c = cand.get(id)!;
          return `${id} | name=${c.name} | marketplace=${c.market ?? '?'} | repo=${c.repo ?? '?'} | desc=${(c.desc ?? '').slice(0, 120)}`;
        });
        const prompt = [
          'You classify Claude Code plugins and map them to a canonical URL.',
          'Official plugins (marketplace "claude-plugins-official") have a page at https://claude.com/plugins/<plugin-name>; others use the source repository (the provided repo).',
          `For each plugin return: "url" (claude.com page if official else repo) and "kind" — the main thing it provides, ONE of: ${KINDS.join('|')}. Use "mcp" for external tool integrations, "commands" for slash commands, "agents" for subagents, "skills" for skill packs, "mixed" if clearly several.`,
          'The JSON key MUST be the exact id before the first " | ". Reply with MINIFIED JSON ONLY (no markdown/fence): {"<id>":{"url":"...","kind":"..."}}.',
          '',
          ...lines,
        ].join('\n');
        return ask({ prompt, maxTokens: 4096 }).then((t) => ({ chunk, map: t ? extractMetaMap(t) : undefined }));
      }),
    );
    for (const { chunk, map } of results) {
      if (!map) continue;
      for (const id of chunk) {
        const name = cand.get(id)!.name;
        const e = map[id] || map[name];
        if (e) cache.meta[id] = { ...cache.meta[id], ...e };
      }
    }
    saveMetaCache(cache);
    log(`[plugin] resolved ${need.length} plugins via haiku`);
  }
  // Aplica: url do cache; kind dos instalados = componentes (preciso) > cache.
  for (const a of data.available) {
    const m = cache.meta[a.pluginId];
    if (m?.url) a.url = m.url;
    if (m?.kind) a.kind = m.kind;
  }
  for (const i of data.installed) {
    const m = cache.meta[i.id];
    if (m?.url && !i.url) i.url = m.url;
    i.kind = i.kind || m?.kind;
  }
}

function extractMetaMap(text: string): Record<string, MetaEntry> | undefined {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) return undefined;
  try {
    const o = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
    const out: Record<string, MetaEntry> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!v || typeof v !== 'object') continue;
      const e = v as { url?: unknown; kind?: unknown };
      const url = typeof e.url === 'string' && /^https?:\/\//.test(e.url) ? e.url : undefined;
      const kind = typeof e.kind === 'string' && KINDS.includes(e.kind) ? e.kind : undefined;
      if (url || kind) out[k] = { url, kind };
    }
    return out;
  } catch {
    return undefined;
  }
}

/** Lista instalados + disponíveis + marketplaces. `forceUrls` re-valida URLs via Haiku. */
export async function listPlugins(claudePath: string, forceUrls = false): Promise<PluginsData> {
  const [listRes, mktRes] = await Promise.all([
    run(claudePath, ['plugin', 'list', '--json', '--available'], 60_000),
    run(claudePath, ['plugin', 'marketplace', 'list', '--json'], 30_000),
  ]);
  const raw = parseJson<RawList>(listRes.out) ?? {};
  const markets = parseJson<RawMarket[]>(mktRes.out) ?? [];
  const marketUrlByName = new Map(markets.filter((m) => m.name).map((m) => [m.name as string, marketUrl(m)]));
  const data: PluginsData = {
    installed: (raw.installed ?? [])
      .filter((p) => p.id)
      .map((p) => {
        const man = readManifest(p.installPath);
        return {
          id: p.id as string,
          version: p.version,
          scope: p.scope,
          enabled: p.enabled !== false,
          description: man.description,
          url: man.url,
          kind: componentKind(p.installPath), // preciso, dos componentes locais
        };
      }),
    available: (raw.available ?? [])
      .filter((p) => p.pluginId)
      .map((p) => ({
        pluginId: p.pluginId as string,
        name: p.name ?? (p.pluginId as string).split('@')[0],
        description: p.description,
        marketplaceName: p.marketplaceName,
        installCount: typeof p.installCount === 'number' ? p.installCount : undefined,
        url: availableUrl(p.source, p.marketplaceName ? marketUrlByName.get(p.marketplaceName) : undefined),
      })),
    marketplaces: markets
      .filter((m) => m.name)
      .map((m) => ({ name: m.name as string, source: m.source, repo: m.repo })),
  };
  // Enriquece URL + tipo via Haiku (cacheado). Best-effort: falha mantém derivado.
  try {
    await resolveMeta(data, forceUrls);
  } catch (e) {
    log(`[plugin] resolveMeta fail: ${String(e)}`);
  }
  return data;
}

/** Argumentos do CLI p/ cada ação. */
function actionArgs(action: PluginAction, arg: string, scope?: string): string[] {
  switch (action) {
    case 'install':
      return ['plugin', 'install', arg, ...(scope ? ['--scope', scope] : [])];
    case 'uninstall':
      return ['plugin', 'uninstall', arg];
    case 'enable':
      return ['plugin', 'enable', arg];
    case 'disable':
      return ['plugin', 'disable', arg];
    case 'update':
      return ['plugin', 'update', arg];
    case 'marketAdd':
      return ['plugin', 'marketplace', 'add', arg];
    case 'marketRemove':
      return ['plugin', 'marketplace', 'remove', arg];
  }
}

/** Executa uma ação. Retorna { ok, message }. */
export async function pluginAction(
  claudePath: string,
  action: PluginAction,
  arg: string,
  scope?: string,
): Promise<{ ok: boolean; message?: string }> {
  const res = await run(claudePath, actionArgs(action, arg, scope));
  if (res.code === 0) {
    log(`[plugin] ${action} ${arg} ok`);
    return { ok: true };
  }
  const message = (res.err || res.out).trim().split('\n').slice(-3).join(' ').slice(0, 240);
  log(`[plugin] ${action} ${arg} fail (${res.code}): ${message}`);
  return { ok: false, message: message || `exit ${res.code}` };
}
