// Live-session registry the CLI keeps in ~/.claude/sessions/<pid>.json — one file per running
// process, written at startup and removed on exit. Measured on CLI 2.1.224; it is the same
// registry that backs `ListAgents` and cross-session messaging.
//
// We read it for ONE reason: to know whether a session we handed to another process is really
// up. Without it the UI can only assume — spawn a terminal and declare success — which is
// exactly the bug the official extension fixed in 2.1.224 ("showing Remote Control as connected
// after the connection failed").
//
// Version-tolerant, like the stream parser: unknown fields are ignored, a malformed or
// half-written file is skipped, and a missing directory just means "nothing is running".
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DIR = path.join(os.homedir(), '.claude', 'sessions');

export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd?: string;
  startedAt?: number;
  kind?: string; // interactive | ... (not pinned: the CLI may add kinds)
  entrypoint?: string;
  name?: string;
  version?: string;
}

/** Every session the CLI currently reports as running. Never throws. */
export async function liveSessions(): Promise<LiveSession[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(DIR);
  } catch {
    return []; // no registry yet: nothing is running
  }
  const out: LiveSession[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const raw = await fs.promises.readFile(path.join(DIR, n), 'utf8');
      const o = JSON.parse(raw) as Partial<LiveSession>;
      if (typeof o?.sessionId !== 'string' || typeof o?.pid !== 'number') continue;
      out.push(o as LiveSession);
    } catch {
      continue; // being written, or not ours to understand
    }
  }
  return out;
}

/**
 * Is this conversation owned by a live process? Matches any of the ids the caller knows for the
 * same conversation (`sessionId` and `resumeId` diverge after a resume), and confirms the pid is
 * actually alive — a process killed hard leaves its file behind.
 */
export async function isSessionLive(...ids: (string | undefined)[]): Promise<boolean> {
  return (await locateSession(...ids)) === 'local';
}

/**
 * Where a handed-over conversation is running now, as far as this machine can tell.
 *
 *  - `local`   a process on THIS machine owns it (pid alive in the registry). This is the
 *              interactive Remote Control terminal we spawned: the handover is `active`.
 *  - `cloud`   the CLI registered the session with a non-interactive kind/entrypoint — a
 *              cloud or phone peer is driving it (the 2.1.229 `cloud` label). No local pid.
 *  - `offline` nobody is running it: the pid died and left no other owner. The 2.1.229
 *              `offline` label — the connection dropped, the transcript is intact on disk.
 *
 * Derived, not read from a field: the local registry file only carries pid/kind/version, so
 * `cloud` is inferred from a live entry whose kind is not `interactive`. Version-tolerant —
 * an unknown kind on a live entry is treated as `cloud`, never as a failure.
 */
export type SessionLocation = 'local' | 'cloud' | 'offline';

export async function locateSession(...ids: (string | undefined)[]): Promise<SessionLocation> {
  const wanted = new Set(ids.filter((i): i is string => !!i));
  if (!wanted.size) return 'offline';
  let cloud = false;
  for (const s of await liveSessions()) {
    if (!wanted.has(s.sessionId)) continue;
    if (pidAlive(s.pid)) {
      // A live entry is `cloud` ONLY when the CLI explicitly tags it with a kind other than
      // interactive. A missing/empty kind stays local: older CLIs and the default headless case
      // do not tag it, and reading "no kind" as cloud would misreport every ordinary handover.
      if (s.kind && s.kind !== 'interactive') {
        cloud = true; // a live entry the CLI does not call interactive: driven elsewhere
        continue;
      }
      return 'local';
    }
  }
  return cloud ? 'cloud' : 'offline';
}

/** `kill(pid, 0)`: no signal sent, only the existence/permission check. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'; // alive, just not ours
  }
}
