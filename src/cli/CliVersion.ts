// Queries the latest Claude Code version on the npm registry and compares it with
// the installed one. Best-effort: network failure → undefined (the UI treats it as up to date).
import * as https from 'node:https';

const PKG = '@anthropic-ai/claude-code';
const TTL_MS = 6 * 60 * 60 * 1000; // 6h
let cache: { latest?: string; at: number } | undefined;

export function getLatestCliVersion(): Promise<string | undefined> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.latest);
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${PKG}/latest`;
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(undefined);
        return;
      }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        let latest: string | undefined;
        try {
          const v = JSON.parse(body)?.version;
          latest = typeof v === 'string' ? v : undefined;
        } catch {
          latest = undefined;
        }
        cache = { latest, at: Date.now() };
        resolve(latest);
      });
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** Extracts "x.y.z" from a string (e.g. "1.0.108 (Claude Code)"). */
export function parseSemver(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : undefined;
}

/** true if `installed` < `latest` (semver). No reliable data → false. */
export function isOutdated(installed?: string, latest?: string): boolean {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}
