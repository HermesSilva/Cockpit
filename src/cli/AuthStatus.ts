// Conta da assinatura via `claude auth status --json` (fonte oficial do CLI).
// Equivale ao bloco ACCOUNT do /usage: método de auth, e-mail, org e plano.
// Assíncrono p/ não bloquear o host da extensão.
import { spawn } from 'node:child_process';
import { readLoginExpiry } from './AiClient';

export interface AccountInfo {
  loggedIn: boolean;
  authMethod?: string; // 'claude.ai' | 'console' | …
  apiProvider?: string; // 'firstParty' | …
  email?: string;
  orgName?: string;
  plan?: string; // subscriptionType ('max' | 'pro' | …)
  // Validade do login (epoch ms). NÃO vem do `auth status --json` — é lida do
  // ~/.claude/.credentials.json. Serve p/ avisar antes do login vencer (o CLI
  // passou a avisar na 2.1.203) e não interromper sessões longas/background.
  loginExpiresAt?: number;
}

/** Busca a conta ao vivo (dado quente). Tolerante: falha/timeout → { loggedIn:false }. */
export function fetchAuthStatus(claudePath: string): Promise<AccountInfo> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (info: AccountInfo) => {
      if (!done) {
        done = true;
        resolve(info);
      }
    };
    try {
      const useShell = process.platform === 'win32';
      const exe =
        useShell && /\s/.test(claudePath) && !claudePath.startsWith('"')
          ? `"${claudePath}"`
          : claudePath;
      const p = spawn(exe, ['auth', 'status', '--json'], { shell: useShell, windowsHide: true });
      const timer = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* noop */
        }
        finish({ loggedIn: false });
      }, 8000);
      let out = '';
      p.stdout?.setEncoding('utf8');
      p.stdout?.on('data', (c: string) => (out += c));
      p.on('error', () => {
        clearTimeout(timer);
        finish({ loggedIn: false });
      });
      p.on('close', () => {
        clearTimeout(timer);
        finish(parse(out));
      });
    } catch {
      finish({ loggedIn: false });
    }
  });
}

function parse(out: string): AccountInfo {
  try {
    const j = JSON.parse(out.trim());
    return {
      loggedIn: !!j.loggedIn,
      authMethod: str(j.authMethod),
      apiProvider: str(j.apiProvider),
      email: str(j.email),
      orgName: str(j.orgName),
      plan: str(j.subscriptionType),
      loginExpiresAt: readLoginExpiry(),
    };
  } catch {
    return { loggedIn: false };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
