// Gerencia o processo do Claude Code CLI em modo headless/streaming.
// Spawna `claude` com stream-json bidirecional, emite eventos parseados.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { StreamParser } from './StreamParser';
import type { ClaudeEvent } from '../../shared/events';

export interface CliOptions {
  claudePath: string;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  resumeSessionId?: string;
}

export interface CliEvents {
  event: (e: ClaudeEvent) => void;
  exit: (code: number | null) => void;
  stderr: (text: string) => void;
}

export class CliProcessManager extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private parser = new StreamParser();
  private reqSeq = 0;

  constructor(private opts: CliOptions) {
    super();
  }

  /** Verifica se o CLI existe e retorna a versão (ou null). */
  static detect(claudePath: string): { ok: boolean; version?: string; error?: string } {
    try {
      // No Windows o `claude` é um .cmd; o Node 22+ recusa executá-lo sem shell
      // (EINVAL/ENOENT, proteção CVE-2024-27980). shell:true resolve via PATHEXT.
      const useShell = process.platform === 'win32';
      const res = spawnSync(shellSafe(claudePath, useShell), ['--version'], {
        encoding: 'utf8',
        timeout: 8000,
        shell: useShell,
      });
      if (res.error) return { ok: false, error: res.error.message };
      if (res.status === 0) {
        return { ok: true, version: (res.stdout || res.stderr || '').trim() };
      }
      return { ok: false, error: (res.stderr || `exit ${res.status}`).trim() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Resolve um `claude` funcional: tenta o caminho configurado (PATH) e, se falhar,
   * sonda os locais do installer NATIVO (~/.local/bin), que não entra no PATH
   * automaticamente no Windows. Retorna o 1º que responde a `--version`.
   */
  static resolve(configured: string): { path: string; ok: boolean; version?: string; error?: string } {
    const candidates = [configured, ...nativeCandidates()];
    let last: { path: string; ok: boolean; version?: string; error?: string } = {
      path: configured,
      ok: false,
    };
    for (const c of candidates) {
      // Caminho absoluto inexistente: pula sem gastar spawn.
      if (c !== configured && !safeExists(c)) continue;
      const d = CliProcessManager.detect(c);
      if (d.ok) return { path: c, ...d };
      last = { path: c, ...d };
    }
    return last;
  }

  isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * Atualiza o id de sessão a retomar caso o processo precise respawnar. O CLI só
   * revela o `session_id` no evento `init`; sem isto, uma reinicialização silenciosa
   * (writeLine após o processo morrer) subiria SEM `--resume` e criaria um contexto
   * novo no disco. Mantém a continuidade da MESMA sessão.
   */
  setResumeId(id: string): void {
    if (id) this.opts.resumeSessionId = id;
  }

  /** Inicia o processo. Idempotente: não faz nada se já estiver rodando. */
  start(): void {
    if (this.proc) return;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      // Roteia as decisões de permissão pelo protocolo de controle (stdin/stdout):
      // com este sentinel o CLI emite control_request `can_use_tool` em vez de negar
      // silenciosamente em modo headless. Também é por aqui que o AskUserQuestion chega.
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') {
      args.push('--permission-mode', this.opts.permissionMode);
    }
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);

    const useShell = process.platform === 'win32';
    const proc = spawn(shellSafe(this.opts.claudePath, useShell), args, {
      cwd: this.opts.cwd,
      env: process.env,
      shell: useShell, // resolve 'claude.cmd' no Windows e evita EINVAL no Node 22+
      // Fora do Windows, dá ao `claude` um GRUPO de processos próprio (detached) p/
      // encerrar a ÁRVORE inteira (claude + subagents) via kill(-pid) no stop().
      // Sem isto, um SIGTERM só no líder deixava netos órfãos. No Windows o
      // shell:true torna `proc` o cmd.exe → lá usamos taskkill /T.
      detached: !useShell,
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      for (const ev of this.parser.push(chunk)) this.emit('event', ev);
    });
    proc.stderr.on('data', (text: string) => this.emit('stderr', text));
    proc.on('close', (code) => {
      for (const ev of this.parser.flush()) this.emit('event', ev);
      this.proc = null;
      this.emit('exit', code);
    });
    proc.on('error', (err) => this.emit('stderr', err.message));

    this.proc = proc;
    // Handshake do protocolo de controle. Habilita o roteamento interativo
    // (can_use_tool / AskUserQuestion) e devolve a lista de slash commands.
    this.writeLine({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } });
  }

  /** Envia uma mensagem do usuário pelo stdin (texto + imagens opcionais). */
  sendUserMessage(text: string, images?: { mediaType: string; data: string }[]): void {
    const content: unknown[] = [];
    if (text) content.push({ type: 'text', text });
    for (const img of images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      });
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });
    this.writeLine({ type: 'user', message: { role: 'user', content } });
  }

  /**
   * Responde a um control_request `can_use_tool`. `response` é o payload de
   * decisão: `{ behavior:'allow', updatedInput, updatedPermissions? }` ou
   * `{ behavior:'deny', message }`. O `allow` exige `updatedInput` (o CLI valida
   * com Zod — devolver só `{behavior:'allow'}` resulta em erro de união).
   */
  sendControlResponse(requestId: string, response: Record<string, unknown>): void {
    this.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  private writeLine(obj: unknown): void {
    if (!this.proc) this.start();
    this.proc?.stdin.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Interrompe o turno atual pelo protocolo de controle (`subtype: 'interrupt'`),
   * mantendo o processo e a SESSÃO vivos. Assim o próximo envio (ex.: o prompt
   * corrigido após cancelar) continua a MESMA sessão, em vez de respawnar uma nova
   * — o que criaria um contexto duplicado no disco. Sem processo, nada a fazer.
   */
  interrupt(): void {
    if (!this.proc) return;
    this.writeLine({
      type: 'control_request',
      request_id: `interrupt_${++this.reqSeq}`,
      request: { subtype: 'interrupt' },
    });
  }

  stop(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    try {
      proc.stdin.end();
    } catch {
      /* noop */
    }
    try {
      // Windows + shell:true -> `proc` é o cmd.exe; matar só ele deixa o `claude`
      // (node) filho órfão e ainda executando. taskkill /T encerra a árvore toda.
      if (process.platform === 'win32' && proc.pid != null) {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else if (proc.pid != null) {
        // Não-Windows: `claude` é líder do próprio grupo (detached). Encerra o grupo
        // inteiro (negativo = grupo) — pega subagents/filhos junto.
        killGroup(proc.pid);
      } else {
        proc.kill('SIGTERM');
      }
    } catch {
      /* noop */
    }
  }
}

/**
 * Encerra a árvore de um processo detached fora do Windows. `process.kill(-pid)`
 * sinaliza o GRUPO inteiro (líder + filhos). SIGTERM primeiro (saída limpa) e,
 * se algo persistir, SIGKILL após uma folga. Tolerante a ESRCH (já morto).
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM'); // sem grupo (raro): mata ao menos o líder
    } catch {
      /* já encerrado */
    }
  }
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* já encerrado */
    }
  }, 2000);
  t.unref?.(); // não segura o event loop
}

/** No Windows com shell, envolve o caminho em aspas se tiver espaços. */
function shellSafe(p: string, useShell: boolean): string {
  if (useShell && /\s/.test(p) && !p.startsWith('"')) return `"${p}"`;
  return p;
}

/** Locais do installer nativo do Claude Code (~/.local/bin). */
function nativeCandidates(): string[] {
  const bin = path.join(os.homedir(), '.local', 'bin');
  return process.platform === 'win32'
    ? [path.join(bin, 'claude.exe'), path.join(bin, 'claude.cmd'), path.join(bin, 'claude')]
    : [path.join(bin, 'claude')];
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
