import { describe, it, expect } from 'vitest';
import { joinAnswer, splitAnswerNote } from '../webview/src/askAnswer';

// O editor por pergunta do modal do Ask acrescenta texto às escolhas. O card da timeline
// precisa desfazer isso, ou a opção escolhida apareceria apagada e tudo viraria "Outro".
describe('Ask — texto acrescentado às escolhas', () => {
  const known = new Set(['Janela de contexto', 'Só docs']);

  it('junta escolhas e texto; texto sozinho também é resposta', () => {
    expect(joinAnswer('Só docs', 'sem bump de versão')).toBe('Só docs\nsem bump de versão');
    expect(joinAnswer('Só docs', '   ')).toBe('Só docs');
    expect(joinAnswer('', 'faça do meu jeito')).toBe('faça do meu jeito');
  });

  it('separa de volta, preservando o casamento com os labels', () => {
    const r = splitAnswerNote('Janela de contexto, Só docs\ne atualize o FAQ', known);
    expect(r.core).toBe('Janela de contexto, Só docs');
    expect(r.note).toBe('e atualize o FAQ');
    expect(r.core.split(',').map((s) => s.trim()).every((tk) => known.has(tk))).toBe(true);
  });

  it('preserva o texto de várias linhas', () => {
    const r = splitAnswerNote(joinAnswer('Só docs', 'primeira\nsegunda'), known);
    expect(r.core).toBe('Só docs');
    expect(r.note).toBe('primeira\nsegunda');
  });

  it('sem texto acrescentado, devolve a resposta intacta', () => {
    expect(splitAnswerNote('Só docs', known)).toEqual({ core: 'Só docs' });
  });

  it('não corta quando a primeira linha não são escolhas conhecidas', () => {
    // Resposta puramente escrita, mesmo com várias linhas: segue inteira ("Outro").
    const ans = 'talvez\nnão sei ainda';
    expect(splitAnswerNote(ans, known)).toEqual({ core: ans });
  });
});
