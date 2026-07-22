// Reusable helper for "utility" AI calls (dictation correction, command metadata
// research, etc.). Uses Anthropic's Messages API directly, with the
// subscription's OAuth token (the same auth as the CLI). It is CLEAN on purpose: it sends only
// system + user, NO tools/MCP/CLAUDE.md/context. Fast (~1-2s) — without the cold
// start (~5s) and the system prompt + tools of a CLI one-shot.
//
// This is NOT the agent loop (that stays in the CLI). It is an isolated utility, under
// the CLAUDE.md exception. Token is READ-only; credentials are never written or logged.
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { log } from '../util/logger';

const CREDS = path.join(os.homedir(), '.claude', '.credentials.json');
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TIMEOUT_MS = 20_000;

// Model for internal calls (correction, command research…). The host injects it
// from the config (tootega.internalModel); empty = Haiku. A per-call override via
// opts.model still wins.
let internalModel = DEFAULT_MODEL;

/** Sets the internal model (called by the host from the config). Empty = Haiku. */
export function setInternalModel(model?: string): void {
  internalModel = model && model.trim() ? model.trim() : DEFAULT_MODEL;
}

/** OAuth accessToken (read-only). undefined when missing/unreadable. */
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
 * LOGIN validity (epoch ms), read-only. This is `refreshTokenExpiresAt`: the
 * `expiresAt` belongs to the accessToken (hours) and the CLI renews it by itself via refresh —
 * what actually expires the login, and forces a `/login`, is the refresh token.
 * Falls back to `expiresAt` only when the refresh field is absent. undefined when
 * missing/unreadable (e.g. API-key account, credential in the OS keychain).
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
 * Asks a one-shot question and returns the response text, or undefined on
 * failure (no token, HTTP != 2xx, timeout, parse). Does not throw.
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
