// Colheita automática de termos técnicos do workspace para alimentar os keyterms
// do STT (header x-config-keyterms). Como o proxy Anthropic NÃO aceita
// language=multi (testado: 1003), o modelo roda monolíngue e deforma palavra
// inglesa em fonema PT. Keyterms é a alavanca que ancora a grafia literal de
// nomes/jargão — então quanto mais termos relevantes do projeto, melhor o
// reconhecimento de "deploy", "commit", "WebSocket", nomes de deps etc.
//
// Fontes (baratas, sem parse de AST): nomes das dependências do package.json +
// um glossário técnico fixo. Tudo deduplicado; o teto final é aplicado em
// buildKeyterms (orçamento de chars do header).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../util/logger';

// Glossário técnico neutro: palavras que o modelo PT costuma deformar e que
// aparecem em ditado de dev. Não inclui nomes de projeto (vêm do workspace).
const TECH_GLOSSARY = [
  'TypeScript', 'JavaScript', 'Node', 'npm', 'React', 'Vite', 'WebSocket',
  'API', 'JSON', 'HTTP', 'HTTPS', 'URL', 'CLI', 'GUI', 'SDK', 'UUID',
  'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'deploy', 'build',
  'debug', 'log', 'lint', 'token', 'cache', 'buffer', 'stream', 'thread',
  'async', 'await', 'callback', 'promise', 'endpoint', 'payload', 'header',
  'webview', 'extension', 'workspace', 'frontend', 'backend', 'runtime',
  'TypeScript', 'Claude', 'Anthropic', 'Deepgram', 'OpenTelemetry', 'OTEL',
];

// Cache por diretório: ler package.json a cada ditado é barato, mas evita
// retrabalho dentro da mesma janela. TTL curto reflete edição do package.json.
const CACHE_TTL_MS = 30_000;
let cache: { cwd: string; at: number; terms: string[] } | undefined;

/** Limpa um nome de dependência npm em termos pronunciáveis. */
function depToTerms(name: string): string[] {
  // "@scope/pkg-name" -> ["scope", "pkg", "name"] + o nome inteiro sem escopo.
  const noScope = name.replace(/^@/, '').replace(/\//g, '-');
  const parts = noScope.split(/[-_.]/g).filter((p) => p.length >= 3 && /[a-z]/i.test(p));
  return parts;
}

/** Lê nomes de deps/devDeps do package.json (vazio se ausente/inválido). */
function harvestPackageJson(cwd: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const o = JSON.parse(raw);
    const names = [...Object.keys(o?.dependencies ?? {}), ...Object.keys(o?.devDependencies ?? {})];
    const out: string[] = [];
    for (const n of names) out.push(...depToTerms(n));
    return out;
  } catch {
    return [];
  }
}

/**
 * Termos técnicos colhidos do workspace + glossário fixo, deduplicados.
 * Resultado entra como "extras" de buildKeyterms (depois dos termos do usuário).
 */
export function workspaceTerms(cwd: string): string[] {
  const now = Date.now();
  if (cache && cache.cwd === cwd && now - cache.at < CACHE_TTL_MS) return cache.terms;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...harvestPackageJson(cwd), ...TECH_GLOSSARY]) {
    const k = t.toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  cache = { cwd, at: now, terms: out };
  log(`[voice] workspace terms colhidos: ${out.length}`);
  return out;
}
