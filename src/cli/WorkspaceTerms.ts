// Automatic harvesting of technical terms from the workspace to feed the STT
// keyterms (x-config-keyterms header). Since the Anthropic proxy does NOT accept
// language=multi (tested: 1003), the model runs monolingual and warps English
// words into pt-BR phonemes. Keyterms is the lever that anchors the literal spelling of
// names/jargon — so the more relevant project terms, the better the
// recognition of "deploy", "commit", "WebSocket", dependency names and so on.
//
// Sources (cheap, no AST parsing): the package.json dependency names +
// a fixed technical glossary. All deduplicated; the final cap is applied in
// buildKeyterms (the header's char budget).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../util/logger';

// Neutral technical glossary: words the pt-BR model tends to warp and that
// show up in developer dictation. It excludes project names (those come from the workspace).
const TECH_GLOSSARY = [
  'TypeScript', 'JavaScript', 'Node', 'npm', 'React', 'Vite', 'WebSocket',
  'API', 'JSON', 'HTTP', 'HTTPS', 'URL', 'CLI', 'GUI', 'SDK', 'UUID',
  'commit', 'push', 'pull', 'merge', 'rebase', 'branch', 'deploy', 'build',
  'debug', 'log', 'lint', 'token', 'cache', 'buffer', 'stream', 'thread',
  'async', 'await', 'callback', 'promise', 'endpoint', 'payload', 'header',
  'webview', 'extension', 'workspace', 'frontend', 'backend', 'runtime',
  'TypeScript', 'Claude', 'Anthropic', 'Deepgram', 'OpenTelemetry', 'OTEL',
];

// Per-directory cache: reading package.json on every dictation is cheap, but this avoids
// redoing it within the same window. The short TTL reflects package.json edits.
const CACHE_TTL_MS = 30_000;
let cache: { cwd: string; at: number; terms: string[] } | undefined;

/** Cleans an npm dependency name into pronounceable terms. */
function depToTerms(name: string): string[] {
  // "@scope/pkg-name" -> ["scope", "pkg", "name"] + the whole name without the scope.
  const noScope = name.replace(/^@/, '').replace(/\//g, '-');
  const parts = noScope.split(/[-_.]/g).filter((p) => p.length >= 3 && /[a-z]/i.test(p));
  return parts;
}

/** Reads deps/devDeps names from package.json (empty when missing/invalid). */
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
 * Technical terms harvested from the workspace + the fixed glossary, deduplicated.
 * The result goes in as buildKeyterms "extras" (after the user's terms).
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
  log(`[voice] workspace terms harvested: ${out.length}`);
  return out;
}
