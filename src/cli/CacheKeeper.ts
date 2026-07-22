// Prompt cache keep-alive. For every context with the checkbox ticked, it re-sends
// a minimal request BEFORE the 1h window expires — so the cached prefix
// doesn't die and the next real use doesn't pay for the cacheWrite again. It works even with the
// tab/context CLOSED: it scans the persisted stats files and resumes via
// `claude --resume <id>` in the right folder.
//
// Critical rule (user's request): NEVER revive an already expired cache. When reopening
// the context or VSCode, if the age is already past 1h the prefix is dead —
// re-sending would only re-cache for nothing (and spend tokens). So we only renew what is still alive.
import { spawn, spawnSync } from 'node:child_process';
import { CACHE_LIFE_MS } from '../stats/StatsAggregator';
import {
  loadAllStats,
  loadStats,
  bumpCacheActivity,
  acquireKeepAliveLock,
  releaseKeepAliveLock,
} from '../stats/StatsStore';
import { log, dlog } from '../util/logger';

/** ms → minutes with 1 decimal (for readable logs). */
function min(ms: number): string {
  return `${(ms / 60_000).toFixed(1)}m`;
}

const TICK_MS = 60_000; // varre 1x por minuto
const REFRESH_LEAD_MS = 5 * 60_000; // renova quando faltam < 5 min p/ expirar (~55 min)
const PING_TIMEOUT_MS = 90_000; // mata o one-shot se travar
// Minimal prompt: it only needs to hit the cached prefix to restart the TTL. The
// explicit instruction avoids actions; in headless without --permission-prompt-tool the
// CLI denies tools by itself (without hanging waiting for approval).
const PING_PROMPT = 'keep-alive: responda apenas "ok". Não use ferramentas nem altere arquivos.';

export interface CacheKeeperDeps {
  claudePath: () => string;
  // Renews an OPEN context through the session's live CLI (no parallel --resume, which
  // would conflict). 'busy' = already warm; 'pinged' = sent; 'none' = no open
  // session → the keeper uses the ephemeral spawn (closed context).
  pingOpen: (sessionId: string) => 'busy' | 'pinged' | 'none';
}

export class CacheKeeper {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<string>(); // sessões com spawn efêmero em andamento

  constructor(private deps: CacheKeeperDeps) {}

  /** Starts the periodic sweep (idempotent). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.(); // não segura o processo aberto
    dlog('cache', `CacheKeeper started (tick ${min(TICK_MS)}, lead ${min(REFRESH_LEAD_MS)})`);
    this.tick(); // checa já na ativação (cobre reabertura do VSCode)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sweep: renews the ticked contexts that are close to expiring. */
  private tick(): void {
    const now = Date.now();
    const all = loadAllStats();
    const marked = all.filter((s) => s.keepCacheAlive);
    dlog('cache', `tick: ${all.length} contexts, ${marked.length} marked keep-alive`);
    for (const s of marked) {
      const id = s.sessionId;
      if (!id || !s.cwd) {
        dlog('cache', `skip ${id ?? '?'}: no ${!id ? 'sessionId' : 'cwd'}`);
        continue;
      }
      if (this.inFlight.has(id)) {
        dlog('cache', `skip ${id}: ping in progress`);
        continue;
      }
      const last = s.lastTurnTs || 0;
      if (last <= 0) {
        dlog('cache', `skip ${id}: no turn (nothing to keep alive)`);
        continue;
      }
      const expiresIn = last + CACHE_LIFE_MS - now;
      if (expiresIn <= 0) {
        dlog('cache', `skip ${id}: EXPIRED ${min(-expiresIn)} ago — not revived`);
        continue; // JÁ VENCIDO: não revive (regra do usuário)
      }
      if (expiresIn > REFRESH_LEAD_MS) {
        dlog('cache', `skip ${id}: healthy (expires in ${min(expiresIn)})`);
        continue;
      }
      if (this.inFlight.has(id)) {
        dlog('cache', `skip ${id}: ephemeral spawn in progress`);
        continue;
      }
      // Cross-instance critical section: several VSCode windows sweep the same
      // directory. The lock guarantees only ONE renews this session at a time.
      if (!acquireKeepAliveLock(id)) {
        dlog('cache', `skip ${id}: another instance holds the lock`);
        continue;
      }
      try {
        // Re-reads FRESH: another instance may have renewed between loadAllStats and the
        // lock. The lastTurnTs on disk is the real "already renewed" signal.
        const fresh = loadStats(id)?.lastTurnTs ?? last;
        if (fresh + CACHE_LIFE_MS - now > REFRESH_LEAD_MS) {
          dlog('cache', `skip ${id}: already renewed by another instance (expires in ${min(fresh + CACHE_LIFE_MS - now)})`);
          continue;
        }
        const open = this.deps.pingOpen(id);
        if (open === 'busy') {
          dlog('cache', `skip ${id}: tab busy (an active turn already keeps it warm)`);
          continue; // turno real em curso bumpará o lastTurnTs
        }
        // Bump on disk RIGHT AWAY: restarts the 1h window at the instant of the ping. Every
        // instance/tick then reads expires≈1h and backs off ~55min. If the ping
        // fails, the cache expires a bit earlier (re-cached on the next use) — fine.
        bumpCacheActivity(id, now);
        if (open === 'pinged') {
          dlog('cache', `due ${id}: expires in ${min(expiresIn)} → ping through the open session`);
          continue; // a sessão também bumpará no result (mais preciso)
        }
        dlog('cache', `due ${id}: expires in ${min(expiresIn)} → ephemeral spawn (closed)`);
        this.refresh(id, s.cwd);
      } finally {
        releaseKeepAliveLock(id);
      }
    }
  }

  /** Resumes the context via a headless one-shot and restarts the cache life on success. */
  private refresh(sessionId: string, cwd: string): void {
    this.inFlight.add(sessionId);
    const useShell = process.platform === 'win32';
    const args = [
      '--resume', sessionId,
      '-p', PING_PROMPT,
      '--output-format', 'json', // one-shot: termina sozinho (sem stream interativo)
      // Without --permission-prompt-tool: in headless the CLI denies tools by itself,
      // without hanging waiting for approval (which used to blow the timeout in plan mode).
    ];
    dlog('cache', `spawn keep-alive ${sessionId} cwd=${cwd}`);
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(shellSafe(this.deps.claudePath(), useShell), args, {
        cwd,
        env: process.env,
        shell: useShell,
        stdio: ['ignore', 'ignore', 'pipe'], // captura stderr p/ diagnóstico
      });
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (t: string) => dlog('cache', `ping stderr ${sessionId}: ${t.trim()}`));
    } catch (e) {
      log(`cache keep-alive spawn fail (${sessionId}): ${String(e)}`);
      this.inFlight.delete(sessionId);
      return;
    }
    const killer = setTimeout(() => {
      try {
        if (useShell && proc.pid != null) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
        else proc.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, PING_TIMEOUT_MS);
    killer.unref?.();
    proc.on('exit', (code) => {
      clearTimeout(killer);
      this.inFlight.delete(sessionId);
      if (code === 0) {
        bumpCacheActivity(sessionId, Date.now()); // reinicia a janela de 1h
        dlog('cache', `keep-alive OK ${sessionId} — 1h window restarted`);
      } else {
        log(`cache keep-alive: ${sessionId} failed (exit ${code})`);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(killer);
      this.inFlight.delete(sessionId);
      log(`cache keep-alive error (${sessionId}): ${err.message}`);
    });
  }
}

/** On Windows with a shell, wraps the path in quotes when it has spaces. */
function shellSafe(p: string, useShell: boolean): string {
  if (useShell && /\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}
