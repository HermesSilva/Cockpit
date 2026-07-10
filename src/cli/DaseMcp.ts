// Integração com o servidor MCP embutido do DASE (extensão do ORM Designer).
//
// O DASE expõe um servidor MCP via Streamable HTTP em loopback (porta padrão
// 39100). Ele é OFF por padrão e, quando ligado, escreve URL e — se exigir auth —
// um token (novo a cada start) no seu globalStorage:
// `<globalStorage>/<ext>/mcp-endpoint.json`.
//
// O ID da extensão DASE varia por publisher/build (`hermessilva.dase`,
// `tootega.dase`…). Em vez de fixar um ID, localizamos o arquivo de descoberta
// varrendo o globalStorage por QUALQUER pasta `*.dase` que contenha o
// mcp-endpoint.json — assim "ligar e conectar" funciona sem caçar o token na mão.
//
// Lido o endpoint, fazemos duas coisas: (a) geramos um arquivo `--mcp-config`
// para o spawn do Cockpit e (b) registramos o servidor no `.claude.json` (escopo
// user), para que QUALQUER sessão `claude` — terminal incluso — enxergue as tools
// `dase_*`. Como o token pode mudar a cada start, ambos são reavaliados a cada
// spawn (barato). Conforme o CLAUDE.md: nunca logamos o token.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DaseEndpoint {
  url: string;
  // Ausente quando o servidor do DASE roda sem autenticação (loopback).
  token?: string;
}

// IDs conhecidos da extensão DASE, na ordem de preferência. A varredura por
// `*.dase` cobre publishers não listados; estes são só o atalho rápido e o gate
// de visibilidade do checkbox (vide ChatViewProvider.daseInstalled).
export const KNOWN_DASE_EXT_IDS = ['hermessilva.dase', 'tootega.dase'];
const DISCOVERY_FILE = 'mcp-endpoint.json';
const DASE_DIR_SUFFIX = '.dase';

/**
 * Localiza o arquivo de descoberta do DASE. Varre as raízes de globalStorage
 * (irmão do nosso próprio + padrões por plataforma): em cada uma tenta primeiro
 * os IDs conhecidos e, senão, qualquer pasta `*.dase` com o mcp-endpoint.json.
 * Retorna o 1º arquivo existente e legível.
 */
export function findDaseEndpointFile(ownGlobalStorageDir?: string): string | undefined {
  const roots: string[] = [];
  if (ownGlobalStorageDir) roots.push(path.dirname(ownGlobalStorageDir));
  roots.push(...platformGlobalStorageRoots());
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    // 1) atalho: IDs conhecidos.
    for (const id of KNOWN_DASE_EXT_IDS) {
      const c = path.join(root, id, DISCOVERY_FILE);
      if (existsSafe(c)) return c;
    }
    // 2) varredura: qualquer `*.dase/mcp-endpoint.json`.
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // raiz inacessível/ausente
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.toLowerCase().endsWith(DASE_DIR_SUFFIX)) continue;
      const c = path.join(root, e.name, DISCOVERY_FILE);
      if (existsSafe(c)) return c;
    }
  }
  return undefined;
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Lê o endpoint do DASE (url + token). undefined se ausente/desligado/ilegível. */
export function readDaseEndpoint(ownGlobalStorageDir?: string): DaseEndpoint | undefined {
  const file = findDaseEndpointFile(ownGlobalStorageDir);
  if (!file) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaseEndpoint>;
    if (typeof j.url === 'string' && j.url) {
      return typeof j.token === 'string' && j.token ? { url: j.url, token: j.token } : { url: j.url };
    }
  } catch {
    /* arquivo corrompido / parcial */
  }
  return undefined;
}

/**
 * Gera o arquivo `--mcp-config` apontando ao servidor DASE (transporte http +
 * Bearer). Escreve em `storageDir` e devolve o caminho. Não usamos
 * `--strict-mcp-config` no chamador: os servidores MCP do usuário continuam.
 */
export function writeDaseMcpConfig(storageDir: string, ep: DaseEndpoint): string {
  const cfg = { mcpServers: { dase: daseServerEntry(ep) } };
  fs.mkdirSync(storageDir, { recursive: true });
  const out = path.join(storageDir, 'dase-mcp.json');
  fs.writeFileSync(out, JSON.stringify(cfg), 'utf8');
  return out;
}

/**
 * Atalho: lê o endpoint e, se houver, grava o config. Devolve o caminho do
 * arquivo `--mcp-config` ou undefined quando o DASE não está disponível.
 */
export function ensureDaseMcpConfig(
  ownGlobalStorageDir: string | undefined,
  storageDir: string,
): string | undefined {
  const ep = readDaseEndpoint(ownGlobalStorageDir);
  if (!ep) return undefined;
  try {
    return writeDaseMcpConfig(storageDir, ep);
  } catch {
    return undefined;
  }
}

/**
 * Caminho do `.claude.json` (config de usuário do Claude Code CLI). Respeita
 * `CLAUDE_CONFIG_DIR`, como o próprio CLI faz.
 */
export function claudeUserConfigPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(dir || os.homedir(), '.claude.json');
}

/** Entrada `mcpServers.dase` que o CLI consome (transporte http). */
function daseServerEntry(ep: DaseEndpoint): Record<string, unknown> {
  const entry: Record<string, unknown> = { type: 'http', url: ep.url };
  // O DASE em loopback pode rodar sem token; só mandamos o header quando existe.
  if (ep.token) entry.headers = { Authorization: `Bearer ${ep.token}` };
  return entry;
}

/**
 * Registra o DASE como servidor MCP de escopo *user* no `.claude.json` —
 * equivalente a `claude mcp add --scope user dase`, porém sem o cold start do
 * CLI. Assim qualquer sessão `claude` (Cockpit, terminal, outro workspace)
 * enxerga as tools `dase_*` sem `--mcp-config`.
 *
 * Idempotente: só reescreve quando a entrada muda (o token do DASE é renovado a
 * cada start do servidor). Escrita atômica (tmp + rename) para não corromper o
 * arquivo se o CLI estiver lendo. Nunca logamos o token.
 *
 * Devolve o que aconteceu; erros viram `'error'` (best-effort, nunca lança).
 */
export function registerDaseInClaudeCli(
  ownGlobalStorageDir?: string,
): 'written' | 'unchanged' | 'unavailable' | 'error' {
  const ep = readDaseEndpoint(ownGlobalStorageDir);
  if (!ep) return 'unavailable';
  const file = claudeUserConfigPath();
  try {
    let cfg: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      // Só mexemos num objeto de verdade; qualquer outra coisa seria sobrescrever
      // config alheia às cegas.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'error';
      cfg = parsed as Record<string, unknown>;
    } catch (e) {
      // Arquivo ausente = primeira execução do CLI: criamos só com o mcpServers.
      // Arquivo corrompido: aborta (não é nosso para reconstruir).
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return 'error';
    }
    const servers =
      cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers)
        ? (cfg.mcpServers as Record<string, unknown>)
        : {};
    const next = daseServerEntry(ep);
    if (JSON.stringify(servers.dase) === JSON.stringify(next)) return 'unchanged';
    servers.dase = next;
    cfg.mcpServers = servers;
    const tmp = `${file}.tootega.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return 'written';
  } catch {
    return 'error';
  }
}

/** Raízes padrão do globalStorage no VS Code estável, por plataforma. */
function platformGlobalStorageRoots(): string[] {
  const join = (...p: string[]) => path.join(...p, 'globalStorage');
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? [join(appData, 'Code', 'User')] : [];
  }
  if (process.platform === 'darwin') {
    return [join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')];
  }
  return [join(os.homedir(), '.config', 'Code', 'User')];
}
