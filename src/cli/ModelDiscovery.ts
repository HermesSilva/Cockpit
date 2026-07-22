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

// Model discovered via /v1/models. `contextTokens` = max_input_tokens (the account's
// real context window; present since 2026-03 — undefined on accounts/versions
// that don't expose it yet).
export interface DiscoveredModel {
  id: string;
  contextTokens?: number;
}

/** Returns the models the credential can access (id + context), or [] on failure. */
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
              const json = JSON.parse(body);
              const models: DiscoveredModel[] = Array.isArray(json?.data)
                ? json.data
                    .filter((m: any) => m?.id)
                    .map((m: any) => ({
                      id: m.id as string,
                      contextTokens:
                        typeof m.max_input_tokens === 'number' ? m.max_input_tokens : undefined,
                    }))
                : [];
              resolve(models);
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
