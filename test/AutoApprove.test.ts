// Bypass no dropdown = nenhum card de permissão, nem para os prompts que o CLI manda
// mesmo sob --permission-mode bypassPermissions (blockReadsOutsideWorkingDirectories a
// partir do 2.1.271, e toda linha Bash que o checker não consegue analisar por inteiro).
// Esses chegam como can_use_tool normal, então quem tem de respondê-los é o host.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliOptions } from '../src/cli/CliProcessManager';

const { spawns, MockCli } = vi.hoisted(() => {
  const spawns: any[] = [];
  class MockCli {
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    // As respostas do protocolo de controle: é o que o teste inspeciona.
    control: { requestId: string; response: any }[] = [];
    constructor(public opts: CliOptions) {
      spawns.push(this);
    }
    on(ev: string, cb: (...a: any[]) => void) {
      const arr = this.handlers.get(ev) ?? [];
      arr.push(cb);
      this.handlers.set(ev, arr);
      return this;
    }
    start() {}
    sendUserMessage() {}
    setResumeId() {}
    interrupt() {}
    stop() {}
    sendControlResponse(requestId: string, response: any) {
      this.control.push({ requestId, response });
    }
    emit(ev: string, ...a: any[]) {
      for (const cb of this.handlers.get(ev) ?? []) cb(...a);
    }
    /** Simula o can_use_tool que o CLI emite quando quer uma decisão. */
    firePermission(requestId: string, tool: string, input: unknown = {}) {
      this.emit('event', {
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'can_use_tool', tool_name: tool, input },
      });
    }
  }
  return { spawns, MockCli };
});

vi.mock('../src/cli/CliProcessManager', () => ({ CliProcessManager: MockCli }));
vi.mock('../src/stats/StatsStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/stats/StatsStore')>()),
  loadStats: () => undefined,
  saveStats: () => {},
}));

import { Session, type SessionHooks } from '../src/session/Session';

// Mensagens que chegariam à webview — um card de permissão aqui significa prompt na tela.
let emitted: any[] = [];
let savedPlans: string[] = [];

function makeSession(permission: string): Session {
  const hooks: SessionHooks = {
    emit: (m: any) => {
      emitted.push(m);
    },
    onBusy: () => {},
    onResult: () => {},
    onInteraction: () => {},
    onInit: () => {},
    onAuthRequired: () => {},
    fileText: () => undefined,
    claudePath: () => 'claude',
    cwd: () => '/tmp/proj',
    settings: () => ({ model: 'default', effort: 'default', permission, allowAgents: true }),
    askLanguage: () => 'en',
    extraSystemPrompt: () => undefined,
    quietPrompt: () => undefined,
    savePlan: (p: string) => {
      savedPlans.push(p);
      return '/tmp/proj/Planing/plan.md';
    },
  };
  return new Session(hooks);
}

describe('Bypass — auto-aprovação no can_use_tool', () => {
  beforeEach(() => {
    spawns.length = 0;
    emitted = [];
    savedPlans = [];
  });

  it('aprova sozinho e NÃO emite card quando o modo é bypassPermissions', () => {
    const s = makeSession('bypassPermissions');
    s.send('prompt');
    // O caso real do usuário: find -exec, que o checker não analisa e pergunta mesmo em Bypass.
    spawns[0].firePermission('req-1', 'Bash', {
      command: 'find Back/Modules -name "X.cs" -exec cat {} \\;',
    });

    expect(spawns[0].control).toHaveLength(1);
    expect(spawns[0].control[0].requestId).toBe('req-1');
    expect(spawns[0].control[0].response.behavior).toBe('allow');
    expect(emitted.filter((m) => m.kind === 'permissionRequest')).toHaveLength(0);
  });

  it('no modo default continua pedindo (emite card, não responde sozinho)', () => {
    const s = makeSession('default');
    s.send('prompt');
    spawns[0].firePermission('req-1', 'Bash', { command: 'rm -rf build' });

    expect(spawns[0].control).toHaveLength(0);
    expect(emitted.filter((m) => m.kind === 'permissionRequest')).toHaveLength(1);
  });

  it('AskUserQuestion NÃO é auto-aprovado nem em Bypass — é pergunta, não permissão', () => {
    const s = makeSession('bypassPermissions');
    s.send('prompt');
    spawns[0].firePermission('req-1', 'AskUserQuestion', {
      questions: [{ question: 'Qual?', header: 'X', options: [] }],
    });

    expect(spawns[0].control).toHaveLength(0);
    expect(emitted.filter((m) => m.kind === 'askRequest')).toHaveLength(1);
  });

  it('ExitPlanMode é aprovado, mas o plano ainda vai para Planing/', () => {
    const s = makeSession('bypassPermissions');
    s.send('prompt');
    spawns[0].firePermission('req-1', 'ExitPlanMode', { plan: '# Plano\npasso 1' });

    expect(spawns[0].control[0].response.behavior).toBe('allow');
    expect(savedPlans).toEqual(['# Plano\npasso 1']);
  });

  it('o override do dropdown vale sobre as settings', () => {
    const s = makeSession('default');
    s.setPermission('bypassPermissions'); // usuário muda o combo no painel
    s.send('prompt');
    spawns[0].firePermission('req-1', 'Bash', { command: 'ls' });

    expect(spawns[0].control[0].response.behavior).toBe('allow');
    expect(emitted.filter((m) => m.kind === 'permissionRequest')).toHaveLength(0);
  });
});
