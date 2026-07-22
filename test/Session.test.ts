// Regression: session continuity vs. context duplication.
// The CLI creates a NEW .jsonl whenever it starts WITHOUT --resume. So, after a stop()
// (model/effort/permission change) the respawn must resume the SAME session.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliOptions } from '../src/cli/CliProcessManager';

// Each mocked CLI instance records the options it was created with (in particular
// resumeSessionId) and exposes the handlers so we can simulate the `init`/`exit` event.
// vi.hoisted: the vi.mock factory is hoisted above the module definitions.
const { spawns, MockCli } = vi.hoisted(() => {
  const spawns: any[] = [];
  class MockCli {
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    sent: string[] = [];
    started = false;
    constructor(public opts: CliOptions) {
      spawns.push(this);
    }
    on(ev: string, cb: (...a: any[]) => void) {
      const arr = this.handlers.get(ev) ?? [];
      arr.push(cb);
      this.handlers.set(ev, arr);
      return this;
    }
    start() {
      this.started = true;
    }
    sendUserMessage(text: string) {
      this.sent.push(text);
    }
    setResumeId(id: string) {
      if (id) this.opts.resumeSessionId = id;
    }
    interrupt() {}
    stop() {}
    emit(ev: string, ...a: any[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...a);
    }
    /** Simulates the `system/init` the CLI emits with the resolved session_id. */
    fireInit(sessionId: string) {
      this.emit('event', { type: 'system', subtype: 'init', session_id: sessionId, slash_commands: [] });
    }
  }
  return { spawns, MockCli };
});

vi.mock('../src/cli/CliProcessManager', () => ({ CliProcessManager: MockCli }));
// No disk side effects in the test (keeps the other exports real).
vi.mock('../src/stats/StatsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/StatsStore')>()),
  loadStats: () => undefined,
  saveStats: () => {},
}));

import { Session, type SessionHooks } from '../src/session/Session';

function makeSession(): Session {
  const hooks: SessionHooks = {
    emit: () => {},
    onBusy: () => {},
    onResult: () => {},
    onInteraction: () => {},
    onInit: () => {},
    onAuthRequired: () => {},
    fileText: () => undefined,
    claudePath: () => 'claude',
    cwd: () => '/tmp/proj',
    settings: () => ({ model: 'default', effort: 'default', permission: 'default', allowAgents: true }),
    askLanguage: () => 'en',
  };
  return new Session(hooks);
}

describe('Session — continuidade de contexto (anti-duplicação)', () => {
  beforeEach(() => {
    spawns.length = 0;
  });

  it('respawn após troca de modelo retoma a MESMA sessão (não duplica)', () => {
    const s = makeSession();
    s.send('primeiro prompt');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].opts.resumeSessionId).toBeUndefined(); // first spawn: new session

    spawns[0].fireInit('sess-A'); // CLI revela o id

    s.setModel('claude-opus-4-8'); // stop() descarta o CLI
    s.send('segundo prompt'); // respawn

    expect(spawns).toHaveLength(2);
    expect(spawns[1].opts.resumeSessionId).toBe('sess-A'); // CONTINUA sess-A
  });

  it('clearConversation começa uma sessão realmente nova (sem --resume)', () => {
    const s = makeSession();
    s.send('prompt');
    spawns[0].fireInit('sess-A');

    s.clearConversation();
    s.send('nova conversa');

    expect(spawns[1].opts.resumeSessionId).toBeUndefined(); // doesn't resume the old one
  });
});
