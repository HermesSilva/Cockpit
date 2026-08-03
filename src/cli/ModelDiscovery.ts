// Optional model discovery via the /v1/models API.
// Works with an API credential (key/bearer via env) OR with the subscription's
// OAuth token (~/.claude/.credentials.json) — so subscription accounts also
// see new models as soon as the account gets them, without depending on the static list.
// GET /v1/models spends NO tokens: it fits the "clean utility" exception in CLAUDE.md
// (same pattern as the usage endpoint). Token is READ-only; never written/logged.
import * as https from 'node:https';
import { readOauthToken } from './AiClient';

export interface DiscoveryCreds {
  apiKey?: string; // x-api-key
  authToken?: string; // Authorization: Bearer (OAuth)
}

export function resolveCreds(settingApiKey?: string): DiscoveryCreds | undefined {
  const apiKey = (settingApiKey && settingApiKey.trim()) || process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey) return { apiKey };
  if (authToken) return { authToken };
  // Subscription without an API key: uses the CLI's OAuth token (same auth, clean call).
  const oauth = readOauthToken();
  if (oauth) return { authToken: oauth };
  return undefined;
}

// Model discovered via /v1/models. Everything the picker shows comes from here — there is
// no curated list in the extension.
//   contextTokens = max_input_tokens (the account's real window; present since 2026-03 —
//                   undefined on accounts/versions that don't expose it yet);
//   displayName   = the official label ("Claude Opus 4.8"), so we never guess it from the id;
//   createdAt     = release date, the picker's ordering key (newest first).
export interface DiscoveredModel {
  id: string;
  contextTokens?: number;
  displayName?: string;
  createdAt?: string;
}

export const ONE_M = 1_000_000;

/** Parses the /v1/models body. Tolerant: an entry without an id is dropped, the rest of the
 *  metadata is optional (an older account may not expose max_input_tokens). */
export function parseModels(json: unknown): DiscoveredModel[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: DiscoveredModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    if (typeof m?.id !== 'string' || !m.id) continue;
    out.push({
      id: m.id,
      contextTokens: typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
      displayName: typeof m.display_name === 'string' ? m.display_name : undefined,
      createdAt: typeof m.created_at === 'string' ? m.created_at : undefined,
    });
  }
  return out;
}

/**
 * The catalogue as picker ids: newest first (created_at), each carrying the `[1m]` suffix when
 * its window is 1M. The suffix is what makes the CLI open the 1M window on the models where it
 * isn't the default, and it is accepted as a no-op on the natively-1M ones (verified on
 * 2.1.220) — so the rule is derived from the data, with no per-model table.
 */
export function pickerIds(models: DiscoveredModel[]): string[] {
  return [...models]
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((m) => (m.contextTokens && m.contextTokens >= ONE_M ? `${m.id}[1m]` : m.id));
}

/** Returns the models the credential can access, or [] on failure. */
export function discoverModels(creds: DiscoveryCreds): Promise<DiscoveredModel[]> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
    if (creds.apiKey) {
      headers['x-api-key'] = creds.apiKey;
    } else if (creds.authToken) {
      headers['authorization'] = `Bearer ${creds.authToken}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      resolve([]);
      return;
    }

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/models?limit=1000',
        method: 'GET',
        headers,
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(parseModels(JSON.parse(body)));
            } catch {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        });
      },
    );
    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
    req.end();
  });
}
