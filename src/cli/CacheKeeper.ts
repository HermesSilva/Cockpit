// Keep-alive do prompt cache. Para cada contexto com o checkbox marcado, reenvia
// uma requisição mínima ANTES da janela de 1h expirar — assim o prefixo cacheado
// não morre e o próximo uso real não re-paga o cacheWrite. Funciona mesmo com a
// aba/contexto FECHADO: varre os arquivos de stats persistidos e retoma via
// `claude --resume <id>` na pasta certa.
//
// Regra crítica (pedido do usuário): NUNCA reviver um cache já vencido. Ao reabrir
// o contexto ou o VSCode, se a idade já passou de 1h, o prefixo já morreu —
// reenviar só re-cacheia à toa (e gasta tokens). Então só renova o que ainda vive.
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

/** ms → minutos com 1 casa (p/ logs legíveis). */
function min(ms: number): string {
  return `${(ms / 60_000).toFixed(1)}m`;
}

const TICK_MS = 60_000; // varre 1x por minuto
const REFRESH_LEAD_MS = 5 * 60_000; // renova quando faltam < 5 min p/ expirar (~55 min)
const PING_TIMEOUT_MS = 90_000; // mata o one-shot se travar
// Prompt mínimo: só precisa acertar o prefixo cacheado p/ reiniciar o TTL. A
// instrução explícita evita ações; em headless sem --permission-prompt-tool, o
// CLI nega ferramentas sozinho (sem travar à espera de aprovação).
const PING_PROMPT = 'keep-alive: responda apenas "ok". Não use ferramentas nem altere arquivos.';

export interface CacheKeeperDeps {
  claudePath: () => string;
  // Renova um contexto ABERTO pelo CLI vivo da sessão (sem --resume paralelo, que
  // conflitaria). 'busy' = já quente; 'pinged' = enviado; 'none' = sem sessão
  // aberta → o keeper usa o spawn efêmero (contexto fechado).
  pingOpen: (sessionId: string) => 'busy' | 'pinged' | 'none';
}

export class CacheKeeper {
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<string>(); // sessões com spawn efêmero em andamento

  constructor(private deps: CacheKeeperDeps) {}

  /** Inicia a varredura periódica (idempotente). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.(); // não segura o processo aberto
    dlog('cache', `CacheKeeper iniciado (tick ${min(TICK_MS)}, lead ${min(REFRESH_LEAD_MS)})`);
    this.tick(); // checa já na ativação (cobre reabertura do VSCode)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Uma varredura: renova os contextos marcados que estão perto de expirar. */
  private tick(): void {
    const now = Date.now();
    const all = loadAllStats();
    const marked = all.filter((s) => s.keepCacheAlive);
    dlog('cache', `tick: ${all.length} contextos, ${marked.length} marcados keep-alive`);
    for (const s of marked) {
      const id = s.sessionId;
      if (!id || !s.cwd) {
        dlog('cache', `skip ${id ?? '?'}: sem ${!id ? 'sessionId' : 'cwd'}`);
        continue;
      }
      if (this.inFlight.has(id)) {
        dlog('cache', `skip ${id}: ping em andamento`);
        continue;
      }
      const last = s.lastTurnTs || 0;
      if (last <= 0) {
        dlog('cache', `skip ${id}: sem turno (nada p/ manter vivo)`);
        continue;
      }
      const expiresIn = last + CACHE_LIFE_MS - now;
      if (expiresIn <= 0) {
        dlog('cache', `skip ${id}: VENCIDO há ${min(-expiresIn)} — não revive`);
        continue; // JÁ VENCIDO: não revive (regra do usuário)
      }
      if (expiresIn > REFRESH_LEAD_MS) {
        dlog('cache', `skip ${id}: saudável (expira em ${min(expiresIn)})`);
        continue;
      }
      if (this.inFlight.has(id)) {
        dlog('cache', `skip ${id}: spawn efêmero em andamento`);
        continue;
      }
      // Seção crítica cross-instância: várias janelas do VSCode varrem o mesmo
      // diretório. O lock garante que só UMA renove esta sessão por vez.
      if (!acquireKeepAliveLock(id)) {
        dlog('cache', `skip ${id}: outra instância detém o lock`);
        continue;
      }
      try {
        // Re-lê FRESCO: outra instância pode ter renovado entre o loadAllStats e o
        // lock. O lastTurnTs no disco é o sinal real de "já renovado".
        const fresh = loadStats(id)?.lastTurnTs ?? last;
        if (fresh + CACHE_LIFE_MS - now > REFRESH_LEAD_MS) {
          dlog('cache', `skip ${id}: já renovado por outra instância (expira em ${min(fresh + CACHE_LIFE_MS - now)})`);
          continue;
        }
        const open = this.deps.pingOpen(id);
        if (open === 'busy') {
          dlog('cache', `skip ${id}: aba ocupada (turno ativo já mantém quente)`);
          continue; // turno real em curso bumpará o lastTurnTs
        }
        // Bump no disco JÁ: reinicia a janela de 1h no instante do ping. Todas as
        // instâncias/ticks passam a ler expira≈1h e recuam ~55min. Se o ping
        // falhar, o cache vence um pouco antes (re-cacheia no próximo uso) — ok.
        bumpCacheActivity(id, now);
        if (open === 'pinged') {
          dlog('cache', `due ${id}: expira em ${min(expiresIn)} → ping pela sessão aberta`);
          continue; // a sessão também bumpará no result (mais preciso)
        }
        dlog('cache', `due ${id}: expira em ${min(expiresIn)} → spawn efêmero (fechado)`);
        this.refresh(id, s.cwd);
      } finally {
        releaseKeepAliveLock(id);
      }
    }
  }

  /** Retoma o contexto via one-shot headless e reinicia a vida do cache no sucesso. */
  private refresh(sessionId: string, cwd: string): void {
    this.inFlight.add(sessionId);
    const useShell = process.platform === 'win32';
    const args = [
      '--resume', sessionId,
      '-p', PING_PROMPT,
      '--output-format', 'json', // one-shot: termina sozinho (sem stream interativo)
      // Sem --permission-prompt-tool: em headless o CLI nega ferramentas sozinho,
      // sem travar à espera de aprovação (o que estourava o timeout no plan mode).
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
        /* já morto */
      }
    }, PING_TIMEOUT_MS);
    killer.unref?.();
    proc.on('exit', (code) => {
      clearTimeout(killer);
      this.inFlight.delete(sessionId);
      if (code === 0) {
        bumpCacheActivity(sessionId, Date.now()); // reinicia a janela de 1h
        dlog('cache', `keep-alive OK ${sessionId} — janela de 1h reiniciada`);
      } else {
        log(`cache keep-alive: ${sessionId} falhou (exit ${code})`);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(killer);
      this.inFlight.delete(sessionId);
      log(`cache keep-alive error (${sessionId}): ${err.message}`);
    });
  }
}

/** No Windows com shell, envolve o caminho em aspas se tiver espaços. */
function shellSafe(p: string, useShell: boolean): string {
  if (useShell && /\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}
