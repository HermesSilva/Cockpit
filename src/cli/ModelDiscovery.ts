// Descoberta opcional de modelos via API /v1/models.
// Só funciona quando há credencial de API (key ou bearer token) — contas de
// assinatura (apiKeySource: none) não têm key e caem no fallback (aliases + custom).
import * as https from 'node:https';

export interface DiscoveryCreds {
  apiKey?: string; // x-api-key
  authToken?: string; // Authorization: Bearer (OAuth)
}

export function resolveCreds(settingApiKey?: string): DiscoveryCreds | undefined {
  const apiKey = (settingApiKey && settingApiKey.trim()) || process.env.ANTHROPIC_API_KEY;
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (apiKey) return { apiKey };
  if (authToken) return { authToken };
  return undefined;
}

/** Retorna os ids de modelo que a credencial acessa, ou [] em qualquer falha. */
export function discoverModels(creds: DiscoveryCreds): Promise<string[]> {
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
              const ids = Array.isArray(json?.data)
                ? json.data.map((m: any) => m?.id).filter((x: unknown): x is string => !!x)
                : [];
              resolve(ids);
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
