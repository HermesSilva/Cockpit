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
  // Workspace da janela do VS Code que subiu este servidor. Presente no discovery
  // por janela; ausente no arquivo legado. Usado para casar o endpoint com a
  // janela certa (cada janela do DASE roda numa porta efêmera própria).
  workspacePath?: string;
}

// IDs conhecidos da extensão DASE, na ordem de preferência. A varredura por
// `*.dase` cobre publishers não listados; estes são só o atalho rápido e o gate
// de visibilidade do checkbox (vide ChatViewProvider.daseInstalled).
export const KNOWN_DASE_EXT_IDS = ['hermessilva.dase', 'tootega.dase'];
// Arquivo legado compartilhado (último a escrever vence) — fallback.
const DISCOVERY_FILE = 'mcp-endpoint.json';
// Arquivo por janela: `mcp-endpoint.<hash>.json`. Cada janela do DASE grava o seu
// (porta efêmera própria) com o campo `workspacePath` para casarmos a janela.
const DISCOVERY_PREFIX = 'mcp-endpoint.';
const DISCOVERY_SUFFIX = '.json';
const DASE_DIR_SUFFIX = '.dase';

/**
 * Localiza as pastas `*.dase` no globalStorage. Varre as raízes (irmão do nosso
 * próprio + padrões por plataforma): em cada uma tenta os IDs conhecidos e,
 * senão, qualquer pasta `*.dase`. Devolve os diretórios existentes, sem repetir.
 */
function daseDirs(ownGlobalStorageDir?: string): string[] {
  const roots: string[] = [];
  if (ownGlobalStorageDir) roots.push(path.dirname(ownGlobalStorageDir));
  roots.push(...platformGlobalStorageRoots());
  const dirs: string[] = [];
  const seenRoot = new Set<string>();
  const seenDir = new Set<string>();
  const add = (d: string) => {
    if (seenDir.has(d) || !existsSafe(d)) return;
    seenDir.add(d);
    dirs.push(d);
  };
  for (const root of roots) {
    if (seenRoot.has(root)) continue;
    seenRoot.add(root);
    for (const id of KNOWN_DASE_EXT_IDS) add(path.join(root, id));
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // raiz inacessível/ausente
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name.toLowerCase().endsWith(DASE_DIR_SUFFIX))
        add(path.join(root, e.name));
    }
  }
  return dirs;
}

/** Todos os arquivos de descoberta (`mcp-endpoint*.json`) nas pastas `*.dase`. */
function daseEndpointFiles(ownGlobalStorageDir?: string): string[] {
  const files: string[] = [];
  for (const dir of daseDirs(ownGlobalStorageDir)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(DISCOVERY_PREFIX) && name.endsWith(DISCOVERY_SUFFIX))
        files.push(path.join(dir, name));
    }
  }
  return files;
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Normaliza um caminho p/ comparação (Windows é case-insensitive). */
function normPath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function parseEndpoint(file: string): DaseEndpoint | undefined {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaseEndpoint>;
    if (typeof j.url !== 'string' || !j.url) return undefined;
    const ep: DaseEndpoint = { url: j.url };
    if (typeof j.token === 'string' && j.token) ep.token = j.token;
    if (typeof j.workspacePath === 'string' && j.workspacePath) ep.workspacePath = j.workspacePath;
    return ep;
  } catch {
    return undefined; // corrompido / parcial
  }
}

/**
 * Localiza o arquivo de descoberta do DASE a usar. Cada janela do DASE roda numa
 * porta efêmera e grava `mcp-endpoint.<hash>.json` com o `workspacePath`. Quando
 * `workspacePath` é informado, preferimos o arquivo daquela janela; senão caímos
 * no legado `mcp-endpoint.json` e, por fim, em qualquer um. undefined se nenhum.
 */
export function findDaseEndpointFile(
  ownGlobalStorageDir?: string,
  workspacePath?: string,
): string | undefined {
  const files = daseEndpointFiles(ownGlobalStorageDir);
  if (files.length === 0) return undefined;
  // 1) casa a janela pelo workspace.
  if (workspacePath) {
    const want = normPath(workspacePath);
    for (const f of files) {
      const ep = parseEndpoint(f);
      if (ep?.workspacePath && normPath(ep.workspacePath) === want) return f;
    }
  }
  // 2) legado compartilhado (nome fixo) como fallback.
  const legacy = files.find((f) => path.basename(f) === DISCOVERY_FILE && !!parseEndpoint(f));
  if (legacy) return legacy;
  // 3) qualquer endpoint legível.
  return files.find((f) => !!parseEndpoint(f));
}

/** Lê o endpoint do DASE (url + token) da janela indicada por `workspacePath`. */
export function readDaseEndpoint(
  ownGlobalStorageDir?: string,
  workspacePath?: string,
): DaseEndpoint | undefined {
  const file = findDaseEndpointFile(ownGlobalStorageDir, workspacePath);
  return file ? parseEndpoint(file) : undefined;
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
  workspacePath?: string,
): string | undefined {
  const ep = readDaseEndpoint(ownGlobalStorageDir, workspacePath);
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
  workspacePath?: string,
): 'written' | 'unchanged' | 'unavailable' | 'error' {
  const ep = readDaseEndpoint(ownGlobalStorageDir, workspacePath);
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
