// Context guard: when the context window passes a threshold (80% by default), make the model
// save what it needs to resume, PROVE it did, and only then compact.
//
// Every step here rests on behaviour measured against the real CLI (2.1.316, stream-json):
//  - A user message written to stdin while a turn runs is delivered at the NEXT TOOL BOUNDARY,
//    inside the same turn (one `result`). With no further tool call, the CLI queues it and runs
//    it as the next turn on its own — a turn the session did not start.
//  - `/compact` written mid-turn is NOT injected: it waits for the turn to end. So it is only
//    ever sent with the session idle.
//  - A compaction is proven by `compact_result: "success"` plus a `compact_boundary` whose
//    `post_tokens < pre_tokens`. The turn's `result` proves nothing: a PreCompact hook that
//    blocks the compaction still ends the turn with a successful `result`.
//
// "Done" is a fact, not an impression: the reply must end with a line whose format and value
// the guard dictated — `COCKPIT-CONTEXT-SAVED <nonce>`, with a nonce minted for this run. A
// missing, stale or approximate line is not done. Nothing is ever compacted without it.
//
// The module has no I/O of its own: the Session feeds it events and carries out what it asks
// through `GuardIO`, which is what lets the whole state machine be unit-tested.

export type GuardPhase = 'saving' | 'retrying' | 'compacting' | 'done' | 'failed' | 'canceled';

/** Why the guard stopped without compacting. The webview turns the code into words. */
export type GuardReason =
  | 'no-confirmation' // the reply never ended with the dictated line (after one retry)
  | 'turn-error' // the save turn ended with an error
  | 'compact-error' // the CLI reported compact_error / compact_result failed
  | 'no-compaction' // the /compact turn ended with no boundary, or one that saved nothing
  | 'interrupted' // the user stopped the turn
  | 'restarted'; // the session's process was restarted or the conversation changed

export interface GuardNotice {
  /** One id per guard run: the webview updates a single banner through all the phases. */
  id: string;
  phase: GuardPhase;
  /** Context fill (0..100, integer) when the run started. */
  pct: number;
  /** Configured threshold (0..100). */
  threshold: number;
  pre?: number;
  post?: number;
  /** Set when the guard paused a task and has asked the model to resume it. */
  resumed?: boolean;
  reason?: GuardReason;
  /** The CLI's own text for `compact-error`, raw. */
  detail?: string;
}

export interface GuardConfig {
  enabled: boolean;
  /** Fraction 0..1 (0.8 = 80%). */
  threshold: number;
}

export interface GuardIO {
  /**
   * Writes a user message to the live CLI. `newTurn` = the session is idle and this message
   * opens a turn (the Session must account for it as one: busy + stopwatch). With
   * `newTurn: false` a turn is running and the message rides inside it.
   */
  send(text: string, newTurn: boolean): void;
  notify(n: GuardNotice): void;
  nonce(): string;
  log(msg: string): void;
}

/** What the Session must do after handing a `result` to the guard. */
export type GuardResultAction = 'expect-queued-turn' | undefined;

export const SENTINEL = 'COCKPIT-CONTEXT-SAVED';
/** Extra fill, in percentage points, before the guard tries again after a failure. */
export const RETRY_STEP = 0.05;
const MAX_ATTEMPTS = 2; // the request + one stricter retry

export function savePrompt(pct: number, threshold: number, nonce: string): string {
  return (
    `[Cockpit context guard] The context window is ${pct}% full (limit ${threshold}%). ` +
    'Pause the current task now and prepare for a context compaction:\n' +
    '1. Save everything needed to resume this work — what is done, what is in progress, what ' +
    "comes next, decisions taken and open questions — following this repository's directives " +
    'for memory and documentation. If the repository provides a skill for saving context or ' +
    'preparing a compaction, use it.\n' +
    '2. Do not continue the task in this turn.\n' +
    '3. End your reply with exactly this line, alone, as the very last line:\n' +
    `${SENTINEL} ${nonce}`
  );
}

export function retryPrompt(nonce: string): string {
  return (
    '[Cockpit context guard] Your previous reply did not end with the required confirmation ' +
    'line. If the state is not fully saved yet, save it first. Then end your reply with exactly ' +
    'this line, alone, as the very last line:\n' +
    `${SENTINEL} ${nonce}`
  );
}

export const COMPACT_COMMAND = '/compact Keep the saved state and the next steps of the paused task.';

export const RESUME_PROMPT =
  '[Cockpit context guard] The context was compacted. Resume the task you paused, starting ' +
  'from the state you saved.';

/**
 * True when the reply's last non-empty line is exactly the sentinel with this nonce. Markdown
 * wrapping the model may add around a lone line (backticks, bold) is tolerated; any other text
 * on that line, another nonce, or the line not being last is not.
 */
export function confirms(reply: string, nonce: string): boolean {
  const lines = reply.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (!last) return false;
  const bare = last.replace(/^[`*_]+|[`*_]+$/g, '').trim();
  return bare === `${SENTINEL} ${nonce}`;
}

type State =
  | { kind: 'idle' }
  | {
      kind: 'saving';
      id: string;
      nonce: string;
      pct: number;
      attempts: number;
      /** The request was written while a turn ran (the task is being paused). */
      midTurn: boolean;
      /** An API call started after the mid-turn write: the message reached the model. */
      delivered: boolean;
      /** The CLI compacted on its own while we were saving. */
      autoCompacted?: { pre?: number; post?: number };
    }
  | {
      kind: 'compacting';
      id: string;
      pct: number;
      midTurn: boolean;
      ok?: boolean;
      error?: string;
      pre?: number;
      post?: number;
    };

export class ContextGuard {
  private state: State = { kind: 'idle' };
  /** After a success: stay quiet until the fill drops below the threshold. */
  private requireBelow = false;
  /** After a failure: try again only once the fill reaches this fraction. 0 = no floor. */
  private retryFloor = 0;
  private lastPct = 0;
  private seq = 0;

  constructor(
    private io: GuardIO,
    private config: () => GuardConfig,
  ) {}

  /** A guard run is in progress (the Session should not start another one of its own). */
  get active(): boolean {
    return this.state.kind !== 'idle';
  }

  /** Current phase, for diagnostics and tests. */
  get phase(): string {
    return this.state.kind;
  }

  /**
   * A new API call started (`message_start`). Marks a mid-turn request as delivered: the CLI
   * hands queued messages to the model together with the tool results of this call.
   */
  onApiCall(): void {
    if (this.state.kind === 'saving' && this.state.midTurn) this.state.delivered = true;
  }

  /** Every context measurement: on each API call and at the end of each turn. */
  onContext(used: number, limit: number, busy: boolean, compacting = false): void {
    if (!(limit > 0) || !(used >= 0)) return;
    const fill = used / limit;
    this.lastPct = fill;
    const cfg = this.config();
    const threshold = clampThreshold(cfg.threshold);
    if (fill < threshold) {
      this.requireBelow = false;
      this.retryFloor = 0;
    }
    if (this.state.kind !== 'idle' || !cfg.enabled || compacting) return;
    if (fill < threshold || this.requireBelow) return;
    if (this.retryFloor > 0 && fill < this.retryFloor) return;
    this.start(fill, threshold, busy);
  }

  private start(fill: number, threshold: number, busy: boolean): void {
    const nonce = this.io.nonce();
    const id = `g${++this.seq}_${nonce}`;
    const pct = Math.floor(fill * 100);
    this.state = { kind: 'saving', id, nonce, pct, attempts: 1, midTurn: busy, delivered: false };
    this.io.log(`context guard: ${pct}% >= ${pct100(threshold)}% -> asking to save (${busy ? 'mid-turn' : 'new turn'}) nonce=${nonce}`);
    this.io.notify({ id, phase: 'saving', pct, threshold: pct100(threshold) });
    this.io.send(savePrompt(pct, pct100(threshold), nonce), !busy);
  }

  /**
   * The turn ended. `reply` is the turn's final text. Returns 'expect-queued-turn' when the
   * request is still sitting in the CLI's queue and will run as the next turn: the Session must
   * account for that turn as its own (busy + stopwatch), or its `result` would be discarded as
   * a stray.
   */
  onResult(reply: string, isError: boolean): GuardResultAction {
    const s = this.state;
    if (s.kind === 'saving') {
      if (isError) return this.fail(s.id, s.pct, 'turn-error');
      if (confirms(reply, s.nonce)) return this.confirmed(s);
      if (s.midTurn && !s.delivered) {
        // The turn finished without another tool boundary: the request never reached the model
        // in it. The CLI runs it next, on its own.
        s.delivered = true;
        this.io.log('context guard: request queued by the CLI; it runs as the next turn');
        return 'expect-queued-turn';
      }
      if (s.attempts >= MAX_ATTEMPTS) return this.fail(s.id, s.pct, 'no-confirmation');
      s.attempts++;
      this.io.log(`context guard: confirmation missing, retry ${s.attempts}/${MAX_ATTEMPTS}`);
      this.io.notify({ id: s.id, phase: 'retrying', pct: s.pct, threshold: this.thresholdPct() });
      this.io.send(retryPrompt(s.nonce), true);
      return undefined;
    }
    if (s.kind === 'compacting') {
      if (s.ok === false) return this.fail(s.id, s.pct, 'compact-error', s.error);
      const saved = s.pre !== undefined && s.post !== undefined && s.post < s.pre;
      if (!s.ok || !saved) return this.fail(s.id, s.pct, 'no-compaction');
      this.finish(s.id, s.pct, s.midTurn, s.pre, s.post);
      return undefined;
    }
    return undefined;
  }

  private confirmed(s: Extract<State, { kind: 'saving' }>): GuardResultAction {
    if (s.autoCompacted) {
      // The CLI already compacted while the model was saving: a second compaction would only
      // re-pay the cache. The state is saved, so go straight to resuming.
      this.io.log('context guard: confirmed; the CLI had already compacted on its own');
      this.finish(s.id, s.pct, s.midTurn, s.autoCompacted.pre, s.autoCompacted.post);
      return undefined;
    }
    this.io.log('context guard: confirmed -> /compact');
    this.state = { kind: 'compacting', id: s.id, pct: s.pct, midTurn: s.midTurn };
    this.io.notify({ id: s.id, phase: 'compacting', pct: s.pct, threshold: this.thresholdPct() });
    this.io.send(COMPACT_COMMAND, true);
    return undefined;
  }

  /** `system/status` with `compact_result` / `compact_error`. */
  onCompactStatus(ok: boolean, error?: string): void {
    if (this.state.kind !== 'compacting') return;
    this.state.ok = ok;
    if (!ok) this.state.error = error;
  }

  /** `system/compact_boundary`. */
  onCompactBoundary(trigger: string | undefined, pre?: number, post?: number): void {
    const s = this.state;
    if (s.kind === 'compacting') {
      s.ok = s.ok ?? true;
      s.pre = pre;
      s.post = post;
      return;
    }
    if (s.kind === 'saving' && trigger === 'auto') {
      s.autoCompacted = { pre, post };
      this.io.log('context guard: the CLI auto-compacted during the save');
    }
  }

  /** The user pressed Stop. */
  onUserInterrupt(): void {
    const s = this.state;
    if (s.kind === 'idle') return;
    this.fail(s.id, s.pct, 'interrupted');
  }

  /** The process was restarted or the conversation changed under the guard. */
  reset(): void {
    const s = this.state;
    if (s.kind !== 'idle') this.fail(s.id, s.pct, 'restarted');
    this.requireBelow = false;
    this.retryFloor = 0;
  }

  private finish(id: string, pct: number, midTurn: boolean, pre?: number, post?: number): void {
    this.state = { kind: 'idle' };
    this.requireBelow = true;
    this.retryFloor = 0;
    this.io.log(`context guard: done ${pre ?? '?'} -> ${post ?? '?'}${midTurn ? ', resuming the task' : ''}`);
    this.io.notify({ id, phase: 'done', pct, threshold: this.thresholdPct(), pre, post, resumed: midTurn });
    if (midTurn) this.io.send(RESUME_PROMPT, true);
  }

  private fail(id: string, pct: number, reason: GuardReason, detail?: string): GuardResultAction {
    this.state = { kind: 'idle' };
    // Never loop on a failure: wait for the fill to grow a few more points (or to drop below
    // the threshold — the CLI's own auto-compaction is still there as the safety net).
    this.retryFloor = Math.max(this.lastPct, clampThreshold(this.config().threshold)) + RETRY_STEP;
    const phase: GuardPhase = reason === 'interrupted' || reason === 'restarted' ? 'canceled' : 'failed';
    this.io.log(`context guard: ${phase} (${reason}${detail ? `: ${detail}` : ''})`);
    this.io.notify({ id, phase, pct, threshold: this.thresholdPct(), reason, detail });
    return undefined;
  }

  private thresholdPct(): number {
    return pct100(clampThreshold(this.config().threshold));
  }
}

/** Keeps the threshold where a save turn still fits before the window fills. */
export function clampThreshold(t: number): number {
  if (!Number.isFinite(t)) return 0.8;
  return Math.min(0.95, Math.max(0.5, t));
}

function pct100(f: number): number {
  return Math.round(f * 100);
}
