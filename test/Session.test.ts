// Regressão: continuidade de sessão x duplicação de contexto.
// O CLI cria um .jsonl NOVO sempre que sobe SEM --resume. Logo, após um stop()
// (troca de model/effort/permission) o respawn precisa retomar a MESMA sessão.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliOptions } from '../src/cli/CliProcessManager';

// Cada instância do CLI mockado registra as opções com que foi criada (em especial
// resumeSessionId) e expõe os handlers para simularmos o evento `init`/`exit`.
// vi.hoisted: a fábrica do vi.mock é içada acima das definições do módulo.
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
    /** Simula o `system/init` que o CLI emite com o session_id resolvido. */
    fireInit(sessionId: string) {
      this.emit('event', { type: 'system', subtype: 'init', session_id: sessionId, slash_commands: [] });
    }
  }
  return { spawns, MockCli };
});

vi.mock('../src/cli/CliProcessManager', () => ({ CliProcessManager: MockCli }));
// Sem efeitos colaterais de disco no teste (mantém demais exports reais).
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
    expect(spawns[0].opts.resumeSessionId).toBeUndefined(); // 1º spawn: sessão nova

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

    expect(spawns[1].opts.resumeSessionId).toBeUndefined(); // não retoma a antiga
  });
});
