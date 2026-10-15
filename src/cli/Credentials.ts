// Single source of truth for the OAuth bearer token the extension's direct Anthropic calls
// use (model discovery, usage, voice, the utility AiClient). It mirrors the `claude` CLI's
// own credential precedence so that EVERY login type the CLI accepts works here too — not
// just a subscription `/login`.
//
// The hazard this fixes: the extension used to read only `~/.claude/.credentials.json`
// (`claudeAiOauth.accessToken`). That file is written by a subscription `/login`, but a
// long-lived token from `claude setup-token` is NEVER saved to disk — the CLI reads it from
// the `CLAUDE_CODE_OAUTH_TOKEN` environment variable (official docs: "It does not save the
// token anywhere"). And `CLAUDE_CONFIG_DIR`, when set, moves the credentials file elsewhere.
// Reading one fixed path therefore left the model picker frozen on its cached catalogue,
// /usage blank, and voice/dictation dead under those logins while the CLI itself worked.
//
// Precedence here follows the CLI's documented order, restricted to the sources that yield a
// bearer token we can send as `Authorization: Bearer` with `anthropic-beta: oauth-2025-04-20`:
//   1. ANTHROPIC_AUTH_TOKEN      (env) — gateway/proxy bearer
//   2. CLAUDE_CODE_OAUTH_TOKEN   (env) — the long-lived `claude setup-token` token
//   3. claudeAiOauth.accessToken (file) — the subscription `/login`, at $CLAUDE_CONFIG_DIR
//      when that is set, else ~/.claude
// `ANTHROPIC_API_KEY` is intentionally NOT here: it is an x-api-key credential, resolved
// separately by the callers that support it (see ModelDiscovery.resolveCreds).
//
// Credentials are READ-ONLY — never written, never logged.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The .credentials.json the CLI would use: honours CLAUDE_CONFIG_DIR, else ~/.claude. */
export function credentialsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const base = dir && dir.length > 0 ? dir : path.join(os.homedir(), '.claude');
  return path.join(base, '.credentials.json');
}

/** Parses the credentials file's `claudeAiOauth` object, or undefined when absent/unreadable. */
function readOauthObject(): Record<string, unknown> | undefined {
  try {
    const o = JSON.parse(fs.readFileSync(credentialsPath(), 'utf8'));
    const oauth = (o as { claudeAiOauth?: unknown })?.claudeAiOauth;
    return oauth && typeof oauth === 'object' ? (oauth as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Trims an env var to a non-empty string, or undefined. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
}

/**
 * The bearer token for direct Anthropic calls, following the CLI's login precedence
 * (env tokens before the on-disk subscription login). undefined only when no OAuth-style
 * credential is resolvable at all. Read-only.
 */
export function readOauthToken(): string | undefined {
  const fromEnv = env('ANTHROPIC_AUTH_TOKEN') ?? env('CLAUDE_CODE_OAUTH_TOKEN');
  if (fromEnv) return fromEnv;
  const oauth = readOauthObject();
  const tok = oauth?.accessToken;
  return typeof tok === 'string' && tok ? tok : undefined;
}

/**
 * LOGIN validity (epoch ms), read-only. This is `refreshTokenExpiresAt`: the `expiresAt`
 * belongs to the accessToken (hours) and the CLI renews it by itself via refresh — what
 * actually expires the login, and forces a `/login`, is the refresh token. Falls back to
 * `expiresAt` only when the refresh field is absent.
 *
 * undefined when it can't be read — which now correctly includes the long-lived-token and
 * env-token logins: those carry no refresh field on disk, so there is no file expiry to warn
 * about (the CLI itself shows no expiry warning for them either).
 */
export function readLoginExpiry(): number | undefined {
  // An env token shadows the file login; its expiry is not represented on disk, so report
  // none rather than a stale file's date that isn't the credential actually in use.
  if (env('ANTHROPIC_AUTH_TOKEN') || env('CLAUDE_CODE_OAUTH_TOKEN')) return undefined;
  const oauth = readOauthObject();
  const ms = (oauth?.refreshTokenExpiresAt ?? oauth?.expiresAt) as unknown;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}
