import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { CliProcessManager } from '../src/cli/CliProcessManager';

// The argument list IS the contract with the engine binary. A typo here does
// not throw: the process starts and stays silent, and the panel looks broken
// for a reason nobody can see. Hence the test.
function argsOf(opts: Partial<Parameters<typeof CliProcessManager>[0]> = {}): string[] {
  const cli = new CliProcessManager({
    claudePath: 'x',
    cwd: 'D:/proj',
    engine: 'tootega',
    ...opts,
  } as never);
  // `tootegaArgs` is private on purpose — nothing outside needs it.
  return (cli as unknown as { tootegaArgs: () => string[] }).tootegaArgs();
}

describe('argumentos do Tootega Code CLI', () => {
  it('traz o contrato de processo que o parser espera', () => {
    const a = argsOf();
    expect(a).toEqual(
      expect.arrayContaining([
        '-p',
        '--output-format',
        'stream-json',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--permission-prompt-tool',
        'stdio',
        '--verbose',
      ]),
    );
  });

  it('passa a pasta de trabalho, que e a raiz do sandbox do agente', () => {
    const a = argsOf();
    expect(a[a.indexOf('--cwd') + 1]).toBe('D:/proj');
  });

  it('so manda --server quando ha um configurado', () => {
    expect(argsOf()).not.toContain('--server');
    const a = argsOf({ server: '127.0.0.1:9000' });
    expect(a[a.indexOf('--server') + 1]).toBe('127.0.0.1:9000');
  });

  it('mapeia plan mode para somente leitura', () => {
    expect(argsOf({ permissionMode: 'plan' })).toContain('--no-tools');
    expect(argsOf({ permissionMode: 'default' })).not.toContain('--no-tools');
  });

  it('mapeia bypassPermissions para --yes', () => {
    expect(argsOf({ permissionMode: 'bypassPermissions' })).toContain('--yes');
    expect(argsOf({ permissionMode: 'default' })).not.toContain('--yes');
  });

  it('nao manda flags do Claude que o agente nao usa', () => {
    const a = argsOf({ model: 'sonnet', effort: 'high' });
    expect(a).not.toContain('--model');
    expect(a).not.toContain('--effort');
    expect(a).not.toContain('--resume');
  });
});

type Internals = { claudeArgs: () => string[]; engineEnv: () => NodeJS.ProcessEnv; tempFiles: string[] };

function claudeOf(opts: Partial<Parameters<typeof CliProcessManager>[0]> = {}): Internals {
  return new CliProcessManager({ claudePath: 'x', cwd: 'D:/proj', ...opts } as never) as unknown as Internals;
}

describe('argumentos do Claude CLI', () => {
  it('manda o modo de permissao sempre, inclusive default (CLI 2.1.285)', () => {
    // Sem a flag, um `-p` sem modo configurado sobe em AUTO em provedor de terceiros ou
    // com telemetria desligada — o combo diria "default" e o CLI rodaria o classificador.
    for (const mode of ['default', 'plan', 'bypassPermissions']) {
      const cli = claudeOf({ permissionMode: mode });
      const a = cli.claudeArgs();
      expect(a[a.indexOf('--permission-mode') + 1]).toBe(mode);
      for (const f of cli.tempFiles) fs.rmSync(f, { force: true });
    }
  });

  it('so liga as ferramentas de tarefas quando pedido (CLI 2.1.268)', () => {
    expect(claudeOf().engineEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBeUndefined();
    expect(claudeOf({ enableTodoTools: true }).engineEnv().CLAUDE_CODE_ENABLE_TODO_TOOLS).toBe('1');
  });
});
