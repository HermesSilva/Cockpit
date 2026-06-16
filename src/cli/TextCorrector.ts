// Correção ortográfica/gramatical do texto ditado, via Haiku — chamada LIMPA e
// rápida na Messages API com o token OAuth da assinatura (mesma auth do CLI).
//
// Por que API direta e não o CLI: o one-shot do CLI tem ~5s de cold start e
// carrega system prompt + todas as tools/MCP a cada chamada. A API manda SÓ a
// instrução (system) + o texto (user) — nada de contexto/tools, ~1.7s, e não
// cria transcript. É um utilitário isolado, não o loop do agente.
//
// Só LEITURA do token (~/.claude/.credentials.json); nunca grava nem loga.
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const MODEL = 'claude-haiku-4-5';
const TIMEOUT_MS = 20_000;

const SYSTEM =
  'Corrija apenas erros de ortografia, acentuação e gramática do texto do usuário. ' +
  'Mantenha exatamente a mesma língua, sentido e tom. ' +
  'Responda SOMENTE com o texto corrigido — sem comentários, sem aspas, sem prefixos.';

function readToken(): string | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS, 'utf8'));
    const tok = o?.claudeAiOauth?.accessToken;
    return typeof tok === 'string' && tok ? tok : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Corrige o texto via Haiku (Messages API + OAuth). Retorna o texto corrigido,
 * ou undefined em falha (o chamador mantém o original).
 */
export function correctText(text: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) {
      log('[correct] no oauth token');
      resolve(undefined);
      return;
    }
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 256)),
      system: SYSTEM,
      messages: [{ role: 'user', content: text }],
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
        timeout: TIMEOUT_MS,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            log(`[correct] http ${res.statusCode}: ${buf.slice(0, 160)}`);
            resolve(undefined);
            return;
          }
          try {
            const j = JSON.parse(buf);
            const out = j?.content?.find((b: any) => b?.type === 'text')?.text;
            const text2 = typeof out === 'string' ? out.trim() : undefined;
            resolve(text2 || undefined);
          } catch (e) {
            log(`[correct] parse fail: ${String(e)}`);
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', (e) => {
      log(`[correct] req error: ${String(e)}`);
      resolve(undefined);
    });
    req.on('timeout', () => {
      req.destroy();
      log('[correct] timeout');
      resolve(undefined);
    });
    req.write(body);
    req.end();
  });
}
