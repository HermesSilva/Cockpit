// Gerencia o processo do Claude Code CLI em modo headless/streaming.
// Spawns `claude` with bidirectional stream-json and emits parsed events.
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
  // Ferramentas a desabilitar no CLI (--disallowedTools). Ex.: ['Task','Workflow']
  // to block subagents/workflows (which spend a lot of tokens). Empty = nothing.
  disallowedTools?: string[];
  resumeSessionId?: string;
  // Short language code (pt, en…) for the AskUserQuestion questions. When
  // set, it injects an append-system-prompt that forces the language of the QUESTIONS only.
  askLanguage?: string;
  // Overrides de listing de skills (--settings JSON). Vale só para ESTE processo:
  // o ~/.claude/settings.json do usuário fica intocado.
  skillOverrides?: Record<string, string>;
}

// Short BCP47 code -> language name for the prompt instruction.
const LANG_NAME: Record<string, string> = {
  pt: 'Brazilian Portuguese (pt-BR)',
  en: 'international English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
};

function askLanguagePrompt(code: string): string {
  const name = LANG_NAME[code] ?? code;
  return (
    `When you use the AskUserQuestion tool, write every question, header text, and ` +
    `option label/description in ${name}. This language rule applies ONLY to ` +
    `AskUserQuestion content, not to your other replies.`
  );
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
  // control_requests NOSSOS aguardando resposta (request_id → resolve).
  private pendingControl = new Map<string, (payload: unknown) => void>();
  // Arquivo temporário de settings do processo atual (removido no stop()).
  private settingsFile?: string;

  constructor(private opts: CliOptions) {
    super();
  }

  /** Checks whether the CLI exists and returns its version (or null). */
  static detect(claudePath: string): { ok: boolean; version?: string; error?: string } {
    try {
      // On Windows `claude` is a .cmd; Node 22+ refuses to run it without a shell
      // (EINVAL/ENOENT, CVE-2024-27980 protection). shell:true resolves it via PATHEXT.
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
   * probes the NATIVE installer locations (~/.local/bin), which don't enter the PATH
   * automatically on Windows. Returns the first that answers `--version`.
   */
  static resolve(configured: string): { path: string; ok: boolean; version?: string; error?: string } {
    const candidates = [configured, ...nativeCandidates()];
    let last: { path: string; ok: boolean; version?: string; error?: string } = {
      path: configured,
      ok: false,
    };
    for (const c of candidates) {
      // Non-existent absolute path: skipped without spending a spawn.
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
   * Updates the session id to resume in case the process needs to respawn. The CLI only
   * reveals the `session_id` in the `init` event; without this, a silent restart
   * (writeLine after the process died) would start WITHOUT `--resume` and create a new
   * context on disk. Keeps the continuity of the SAME session.
   */
  setResumeId(id: string): void {
    if (id) this.opts.resumeSessionId = id;
  }

  /** Starts the process. Idempotent: does nothing when already running. */
  start(): void {
    if (this.proc) return;
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--include-partial-messages',
      // Routes permission decisions through the control protocol (stdin/stdout):
      // with this sentinel the CLI emits a `can_use_tool` control_request instead of denying
      // silently in headless mode. AskUserQuestion also arrives through here.
      '--permission-prompt-tool', 'stdio',
      '--verbose',
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.effort) args.push('--effort', this.opts.effort);
    if (this.opts.permissionMode && this.opts.permissionMode !== 'default') {
      args.push('--permission-mode', this.opts.permissionMode);
    }
    if (this.opts.disallowedTools?.length) {
      args.push('--disallowedTools', this.opts.disallowedTools.join(','));
    }
    if (this.opts.resumeSessionId) args.push('--resume', this.opts.resumeSessionId);
    if (this.opts.askLanguage) {
      args.push('--append-system-prompt', askLanguagePrompt(this.opts.askLanguage));
    }
    // `--settings` é MERGE (não substitui as settings do usuário) e aceita caminho OU
    // string JSON — mas JSON inline não sobrevive ao shell do Windows (aspas/chaves são
    // mastigadas por cmd.exe e o CLI sobe sem os overrides). Gravamos um arquivo temporário.
    const settingsFile = this.writeSettingsFile();
    if (settingsFile) args.push('--settings', settingsFile);

    const useShell = process.platform === 'win32';
    // Auto mode (the CLI classifier decides allow/deny) is opt-in on Bedrock/Vertex/
    // Foundry via env (2.1.158/159). Defensive: we turn the flag on when the mode is 'auto'
    // so it behaves uniformly across providers. It does NOT bypass permissions — it only enables the
    // CLI's native mode, which still routes what it must through control_request.
    const env =
      this.opts.permissionMode === 'auto'
        ? { ...process.env, CLAUDE_CODE_ENABLE_AUTO_MODE: '1' }
        : process.env;
    const proc = spawn(shellSafe(this.opts.claudePath, useShell), args, {
      cwd: this.opts.cwd,
      env,
      shell: useShell, // resolve 'claude.cmd' no Windows e evita EINVAL no Node 22+
      // Outside Windows, gives `claude` its own process GROUP (detached) so the
      // WHOLE TREE (claude + subagents) can be ended via kill(-pid) in stop().
      // Without this, a SIGTERM to the leader alone left orphan grandchildren. On Windows
      // shell:true makes `proc` the cmd.exe → there we use taskkill /T.
      detached: !useShell,
    }) as ChildProcessWithoutNullStreams;

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    proc.stdout.on('data', (chunk: string) => {
      for (const ev of this.parser.push(chunk)) {
        this.settleControl(ev);
        this.emit('event', ev);
      }
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

  /** Sends a user message through stdin (text + optional images). */
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
   * Answers a `can_use_tool` control_request. `response` is the decision
   * payload: `{ behavior:'allow', updatedInput, updatedPermissions? }` or
   * `{ behavior:'deny', message }`. O `allow` exige `updatedInput` (o CLI valida
   * with Zod — returning only `{behavior:'allow'}` results in a union error).
   */
  sendControlResponse(requestId: string, response: Record<string, unknown>): void {
    this.writeLine({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
  }

  /**
   * Grava as settings extras deste processo (só os overrides de skills) num arquivo
   * temporário e devolve o caminho. Sem overrides, ou se a escrita falhar, devolve
   * undefined — o CLI sobe normalmente, sem o `--settings`.
   */
  private writeSettingsFile(): string | undefined {
    const overrides = this.opts.skillOverrides;
    if (!overrides || Object.keys(overrides).length === 0) return undefined;
    const file = path.join(os.tmpdir(), `cockpit-settings-${process.pid}-${++this.reqSeq}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ skillOverrides: overrides }), 'utf8');
      this.settingsFile = file;
      return file;
    } catch {
      return undefined;
    }
  }

  /**
   * Envia um control_request nosso e espera a resposta correlacionada por `request_id`.
   * Usado pelo `get_context_usage` (cálculo local do engine: sem turno, sem tokens).
   * Resolve `undefined` no timeout ou quando o CLI responde erro — nunca rejeita, para
   * que uma versão de CLI sem esse subtype não derrube nada.
   */
  requestControl(subtype: string, timeoutMs = 5000): Promise<unknown> {
    const id = `${subtype}_${++this.reqSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(id, (payload) => {
        clearTimeout(timer);
        resolve(payload);
      });
      this.writeLine({ type: 'control_request', request_id: id, request: { subtype } });
    });
  }

  /** Resolve o control_request nosso que estava esperando por este `request_id`. */
  private settleControl(ev: ClaudeEvent): void {
    if ((ev as any).type !== 'control_response') return;
    const resp = (ev as any).response;
    const id = resp?.request_id;
    if (typeof id !== 'string') return;
    const done = this.pendingControl.get(id);
    if (!done) return;
    this.pendingControl.delete(id);
    done(resp?.subtype === 'success' ? resp.response : undefined);
  }

  private writeLine(obj: unknown): void {
    if (!this.proc) this.start();
    this.proc?.stdin.write(JSON.stringify(obj) + '\n');
  }

  /**
   * Interrupts the current turn through the control protocol (`subtype: 'interrupt'`),
   * keeping the process and the SESSION alive. That way the next send (e.g. the prompt
   * fixed after cancelling) continues the SAME session, instead of respawning a new one
   * — which would create a duplicated context on disk. With no process, there is nothing to do.
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
    // Ninguém mais vai responder: libera quem espera em vez de deixar pendurado até o timeout.
    for (const done of this.pendingControl.values()) done(undefined);
    this.pendingControl.clear();
    if (this.settingsFile) {
      try {
        fs.unlinkSync(this.settingsFile);
      } catch {
        /* arquivo temporário: some no boot seguinte */
      }
      this.settingsFile = undefined;
    }
    try {
      proc.stdin.end();
    } catch {
      /* noop */
    }
    try {
      // Windows + shell:true -> `proc` is the cmd.exe; killing only it leaves the child
      // `claude` (node) orphaned and still running. taskkill /T ends the whole tree.
      if (process.platform === 'win32' && proc.pid != null) {
        spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
      } else if (proc.pid != null) {
        // Non-Windows: `claude` leads its own group (detached). Ends the group
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
 * Ends the tree of a detached process outside Windows. `process.kill(-pid)`
 * signals the WHOLE GROUP (leader + children). SIGTERM first (clean exit) and,
 * if something persists, SIGKILL after a grace period. Tolerant to ESRCH (already dead).
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM'); // no group (rare): at least kills the leader
    } catch {
      /* already ended */
    }
  }
  const t = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already ended */
    }
  }, 2000);
  t.unref?.(); // doesn't hold the event loop
}

/** On Windows with a shell, wraps the path in quotes when it has spaces. */
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
