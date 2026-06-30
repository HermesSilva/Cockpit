// Integração com o servidor MCP embutido do DASE (extensão tootega.dase).
//
// O DASE expõe um servidor MCP via Streamable HTTP em loopback. Ele é OFF por
// padrão e, quando ligado, escreve URL + token (token novo a cada start) no seu
// globalStorage: `<globalStorage>/tootega.dase/mcp-endpoint.json`.
//
// Aqui localizamos esse arquivo de descoberta, lemos o endpoint e geramos um
// arquivo `--mcp-config` que o Claude Code CLI consome para enxergar as tools do
// DASE. Como o token muda a cada start do DASE, regeneramos o config a cada spawn
// (barato). Conforme o CLAUDE.md: nunca logamos o token.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DaseEndpoint {
  url: string;
  token: string;
}

const DASE_EXT_ID = 'tootega.dase';
const DISCOVERY_FILE = 'mcp-endpoint.json';

/**
 * Localiza o arquivo de descoberta do DASE. Tenta primeiro o irmão do nosso
 * próprio globalStorage (mesmo host: VS Code, Insiders, Cursor…), depois o local
 * padrão por plataforma do VS Code estável. Retorna o 1º que existir.
 */
export function findDaseEndpointFile(ownGlobalStorageDir?: string): string | undefined {
  const candidates: string[] = [];
  if (ownGlobalStorageDir) {
    // .../User/globalStorage/<nossa-ext> -> irmão .../tootega.dase/mcp-endpoint.json
    candidates.push(path.join(path.dirname(ownGlobalStorageDir), DASE_EXT_ID, DISCOVERY_FILE));
  }
  candidates.push(...platformGlobalStorageGuesses());
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignora candidato inacessível */
    }
  }
  return undefined;
}

/** Lê o endpoint do DASE (url + token). undefined se ausente/desligado/ilegível. */
export function readDaseEndpoint(ownGlobalStorageDir?: string): DaseEndpoint | undefined {
  const file = findDaseEndpointFile(ownGlobalStorageDir);
  if (!file) return undefined;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DaseEndpoint>;
    if (typeof j.url === 'string' && j.url && typeof j.token === 'string' && j.token) {
      return { url: j.url, token: j.token };
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
  const cfg = {
    mcpServers: {
      dase: {
        type: 'http',
        url: ep.url,
        headers: { Authorization: `Bearer ${ep.token}` },
      },
    },
  };
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

/** Locais padrão do globalStorage do DASE no VS Code estável, por plataforma. */
function platformGlobalStorageGuesses(): string[] {
  const join = (...p: string[]) => path.join(...p, 'globalStorage', DASE_EXT_ID, DISCOVERY_FILE);
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return appData ? [join(appData, 'Code', 'User')] : [];
  }
  if (process.platform === 'darwin') {
    return [join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')];
  }
  return [join(os.homedir(), '.config', 'Code', 'User')];
}
