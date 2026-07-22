// Texto extra do usuário injetado no system prompt do CLI (--append-system-prompt).
//
// O texto é um TEMPLATE com placeholders ${nome}. A expansão descreve a máquina REAL:
// nada é afirmado sem checar. Três regras, nessa ordem:
//
//  1. placeholder resolvido            → substitui pelo valor;
//  2. placeholder cuja dependência NÃO existe (shell/app/pasta ausente)
//                                      → a LINHA inteira que o contém é removida
//                                        (uma linha de tabela sobre um shell inexistente
//                                         é pior que a ausência dela: induz o agente ao erro);
//  3. placeholder desconhecido         → fica como está (não inventamos valor).
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { dlog } from '../util/logger';

/** Valor de um placeholder. `undefined` = dependência ausente → remove a linha. */
type Vars = Record<string, string | undefined>;

/** Ambiente detectado uma vez por processo do host (a detecção roda subprocessos). */
interface Env {
  /** Nome do shell padrão, já com a versão quando conhecida. */
  defaultShell: string;
  psVersion?: string; // só no Windows
  gitBash: boolean;
  wsl?: string; // distro padrão do WSL, quando existe
  winPathStyle: string;
}

let cached: Env | undefined;

/** Executa um comando curto e devolve o stdout; `undefined` quando falha/não existe. */
function probe(cmd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const clean = out.replace(/\0/g, '').trim();
    return clean || undefined;
  } catch {
    return undefined;
  }
}

/** Caminho do Git Bash: existe mesmo, não "provavelmente existe". */
function findGitBash(): boolean {
  const candidates = [
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return true;
    } catch {
      /* caminho ilegível: conta como ausente */
    }
  }
  return probe('bash', ['--version']) !== undefined;
}

function detectEnv(): Env {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    const shell = path.basename(process.env.SHELL ?? 'bash');
    cached = { defaultShell: shell, gitBash: true, winPathStyle: 'POSIX (/home/...)' };
    return cached;
  }
  // pwsh 7+ quando instalado; senão o Windows PowerShell 5.1 que vem com o SO.
  const pwsh = probe('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  const ps51 = pwsh
    ? undefined
    : probe('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']);
  const psVersion = pwsh ?? ps51;
  const defaultShell = pwsh ? `PowerShell ${pwsh}` : ps51 ? `Windows PowerShell ${ps51}` : 'cmd.exe';
  // `wsl -l -q` só lista algo quando há distro instalada; sem distro o WSL não serve.
  const wslList = probe('wsl', ['-l', '-q']);
  const wsl = wslList?.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  cached = {
    defaultShell,
    psVersion,
    gitBash: findGitBash(),
    wsl,
    winPathStyle: 'Windows (C:\\...)',
  };
  dlog('prompt', `env: shell=${defaultShell} gitBash=${cached.gitBash} wsl=${wsl ?? 'none'}`);
  return cached;
}

/** Só para os testes: força a redetecção do ambiente. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Caminho do workspace como o Git Bash o enxerga: D:\a\b → /d/a/b. */
function toGitBashPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Caminho do workspace dentro do WSL: D:\a\b → /mnt/d/a/b. */
function toWslPath(p: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (!m) return p.replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

/** Placeholders suportados, já resolvidos contra a máquina real. */
export function buildVars(cwd: string, env: Env = detectEnv()): Vars {
  return {
    defaultShell: env.defaultShell,
    psVersion: env.psVersion,
    winPathStyle: env.winPathStyle,
    projectPathWin: cwd,
    projectPathGitBash: env.gitBash ? toGitBashPath(cwd) : undefined,
    projectPathWsl: env.wsl ? toWslPath(cwd) : undefined,
    // Linha inteira da tabela: sem WSL, o placeholder some junto com a linha.
    wslRow: env.wsl
      ? `| WSL (${env.wsl}) | Linux real | ${toWslPath(cwd)} | /tmp (dentro do WSL) | ok |`
      : undefined,
    os: `${os.type()} ${os.release()}`,
    tempDir: os.tmpdir(),
  };
}

const PLACEHOLDER = /\$\{([A-Za-z][\w]*)\}/g;

/**
 * Expande o template. Linha com placeholder cuja dependência não existe é removida
 * inteira; placeholder desconhecido é preservado literalmente.
 */
export function expandTemplate(text: string, vars: Vars): string {
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    let drop = false;
    const out = line.replace(PLACEHOLDER, (whole, name: string) => {
      if (!(name in vars)) return whole; // desconhecido: não inventamos nada
      const v = vars[name];
      if (v === undefined) {
        drop = true; // dependência ausente nesta máquina
        return '';
      }
      return v;
    });
    if (!drop) kept.push(out);
  }
  // Uma linha removida no meio de um bloco não deve deixar dois espaços em branco.
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Texto final para o `--append-system-prompt`. Devolve `undefined` quando não há nada
 * a injetar (desligado, vazio, ou o template inteiro caiu na validação).
 */
export function buildSystemPrompt(text: string | undefined, cwd: string): string | undefined {
  if (!text || !text.trim()) return undefined;
  const out = expandTemplate(text, buildVars(cwd));
  return out || undefined;
}
