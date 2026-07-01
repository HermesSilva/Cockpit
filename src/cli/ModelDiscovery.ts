// Descoberta opcional de modelos via API /v1/models.
// Funciona com credencial de API (key/bearer via env) OU com o token OAuth da
// assinatura (~/.claude/.credentials.json) — assim contas de assinatura também
// veem modelos novos assim que a conta os libera, sem depender da lista estática.
// GET /v1/models NÃO gasta token: cabe na exceção "utilitária limpa" do CLAUDE.md
// (mesmo padrão do endpoint de usage). Só LEITURA do token; nunca grava/loga.
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
  // Assinatura sem API key: usa o token OAuth do CLI (mesma auth, chamada limpa).
  const oauth = readOauthToken();
  if (oauth) return { authToken: oauth };
  return undefined;
}

// Modelo descoberto via /v1/models. `contextTokens` = max_input_tokens (janela
// de contexto real da conta; presente desde mar/2026 — undefined em contas/versões
// que ainda não o expõem).
export interface DiscoveredModel {
  id: string;
  contextTokens?: number;
}

/** Retorna os modelos que a credencial acessa (id + contexto), ou [] em falha. */
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
