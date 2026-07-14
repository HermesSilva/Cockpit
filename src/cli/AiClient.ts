// Helper reusável p/ chamadas de IA "utilitárias" (correção de ditado, pesquisa de
// metadados de comandos, etc.). Usa a Messages API da Anthropic direto, com o
// token OAuth da assinatura (mesma auth do CLI). É LIMPO de propósito: manda só
// system + user, NENHUMA tool/MCP/CLAUDE.md/contexto. Rápido (~1-2s) — sem o cold
// start (~5s) e o system prompt + tools do one-shot do CLI.
//
// NÃO é o loop do agente (esse continua no CLI). É um utilitário isolado, na
// exceção do CLAUDE.md. Só LEITURA do token; nunca grava nem loga credenciais.
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 20_000;

// Modelo das chamadas internas (correção, pesquisa de comandos…). O host injeta
// da config (tootega.internalModel); vazio = Haiku. Override por chamada via
// opts.model ainda vence.
let internalModel = DEFAULT_MODEL;

/** Define o modelo interno (chamado pelo host na config). Vazio = Haiku. */
export function setInternalModel(model?: string): void {
  internalModel = model && model.trim() ? model.trim() : DEFAULT_MODEL;
}

/** accessToken OAuth (só leitura). undefined se ausente/ilegível. */
export function readOauthToken(): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const tok = o?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validade do LOGIN (epoch ms), só leitura. É o `refreshTokenExpiresAt`: o
 * `expiresAt` é do accessToken (horas) e o CLI o renova sozinho pelo refresh —
 * quem realmente vence o login, e obriga a rodar `/login`, é o refresh token.
 * Cai no `expiresAt` só quando o campo do refresh não existe. undefined se
 * ausente/ilegível (ex.: conta por API key, credencial em keychain do SO).
 */
export function readLoginExpiry(): number | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const oauth = o?.claudeAiOauth;
    const ms = oauth?.refreshTokenExpiresAt ?? oauth?.expiresAt;
    return typeof ms === 'number' && ms > 0 ? ms : undefined;
  } catch {
    return undefined;
  }
}

export interface AskOpts {
  prompt: string; // conteúdo da mensagem do usuário
  system?: string; // instrução de sistema (opcional)
  model?: string; // default: Haiku
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * Faz uma pergunta one-shot e devolve o texto da resposta, ou undefined em
 * falha (sem token, HTTP != 2xx, timeout, parse). Não lança.
 */
export function ask(opts: AskOpts): Promise<string | undefined> {
  return new Promise((resolve) => {
    const token = readOauthToken();
    if (!token) {
      log('[ai] no oauth token');
      resolve(undefined);
      return;
    }
    const body = JSON.stringify({
      model: opts.model || internalModel,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: 'user', content: opts.prompt }],
    });
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            log(`[ai] http ${res.statusCode}: ${buf.slice(0, 160)}`);
            resolve(undefined);
            return;
          }
          try {
            const j = JSON.parse(buf);
            const out = j?.content?.find((b: any) => b?.type === 'text')?.text;
            resolve(typeof out === 'string' && out.trim() ? out.trim() : undefined);
          } catch (e) {
            log(`[ai] parse fail: ${String(e)}`);
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', (e) => {
      log(`[ai] req error: ${String(e)}`);
      resolve(undefined);
    });
    req.on('timeout', () => {
      req.destroy();
      log('[ai] timeout');
      resolve(undefined);
    });
    req.write(body);
    req.end();
  });
}
