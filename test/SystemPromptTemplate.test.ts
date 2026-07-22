// Expansão do texto do usuário injetado no system prompt.
// A regra que importa: nunca descrever para o agente um shell/pasta que não existe aqui.
import { describe, it, expect } from 'vitest';
import { expandTemplate, buildSystemPrompt } from '../src/cli/SystemPromptTemplate';

const TABLE = [
  '| Shell | Quando |',
  '|-------|--------|',
  '| ${defaultShell} (DEFAULT) | tudo |',
  '| Git Bash | ${projectPathGitBash} |',
  '${wslRow}',
].join('\n');

describe('expandTemplate', () => {
  it('substitui o que existe', () => {
    const out = expandTemplate('shell: ${defaultShell}', { defaultShell: 'PowerShell 7.4.6' });
    expect(out).toBe('shell: PowerShell 7.4.6');
  });

  // Uma linha de tabela sobre WSL numa máquina sem WSL induz o agente ao erro:
  // some inteira em vez de virar uma linha vazia ou um "${wslRow}" cru.
  it('remove a LINHA inteira quando a dependência não existe', () => {
    const out = expandTemplate(TABLE, {
      defaultShell: 'pwsh',
      projectPathGitBash: undefined, // sem Git Bash
      wslRow: undefined, // sem WSL
    });
    expect(out).toContain('| pwsh (DEFAULT) | tudo |');
    expect(out).not.toContain('Git Bash');
    expect(out).not.toContain('${');
    expect(out.split('\n')).toHaveLength(3); // cabeçalho + separador + default
  });

  it('mantém as linhas quando tudo existe', () => {
    const out = expandTemplate(TABLE, {
      defaultShell: 'pwsh',
      projectPathGitBash: '/d/proj',
      wslRow: '| WSL (Ubuntu) | Linux |',
    });
    expect(out).toContain('/d/proj');
    expect(out).toContain('WSL (Ubuntu)');
  });

  // Não inventamos valor para o que não conhecemos: fica visível para o usuário corrigir.
  it('preserva placeholder desconhecido', () => {
    expect(expandTemplate('x ${naoExiste} y', { defaultShell: 'pwsh' })).toBe('x ${naoExiste} y');
  });

  it('não deixa buraco de linhas em branco onde algo foi removido', () => {
    const out = expandTemplate('a\n${some}\n\n\nb', { some: undefined });
    expect(out).toBe('a\n\nb');
  });
});

describe('buildSystemPrompt', () => {
  it('vazio/desligado não injeta nada', () => {
    expect(buildSystemPrompt(undefined, 'D:\\p')).toBeUndefined();
    expect(buildSystemPrompt('   ', 'D:\\p')).toBeUndefined();
  });

  // Determinístico: não depende de esta máquina ter (ou não) WSL/Git Bash.
  it('template que some por inteiro não vira string vazia', () => {
    expect(expandTemplate('${x}', { x: undefined })).toBe('');
  });

  it('resolve o caminho do projeto contra a máquina real', () => {
    const out = buildSystemPrompt('projeto: ${projectPathWin}', 'D:\\Tootega\\Source\\Cockpit');
    expect(out).toBe('projeto: D:\\Tootega\\Source\\Cockpit');
  });
});
