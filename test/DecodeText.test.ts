import { describe, it, expect } from 'vitest';
import { decodeFlattenedUnicode as dec } from '../webview/src/util/decodeText';

// O modelo às vezes emite o input do tool_use com o escape achatado (`u00f3` sem a barra).
// O painel de Ask conserta isso na exibição. Casos reais tirados da tela reportada.
describe('decodeFlattenedUnicode — conserto de escapes achatados', () => {
  it('recupera os acentos da tela reportada', () => {
    expect(dec('su00f3')).toBe('só');
    expect(dec('nu00e3o')).toBe('não');
    expect(dec('vocu00ea')).toBe('você');
    expect(dec('cu00f3digo')).toBe('código');
    expect(dec('papu00e9is')).toBe('papéis');
    expect(dec('hu00e1')).toBe('há');
    expect(dec('assinatura nem vu00eda no menu')).toBe('assinatura nem vía no menu');
  });

  it('conserta uma frase inteira com várias ocorrências', () => {
    const bad = 'Hoje XApplicationScope su00f3 tem TenantAdmin — nu00e3o hu00e1 valor';
    expect(dec(bad)).toBe('Hoje XApplicationScope só tem TenantAdmin — não há valor');
  });

  it('NÃO toca um escape correto (com a barra) nem texto já são', () => {
    // Um \uXXXX real nunca chega como texto (JSON.parse já resolveu), mas garantimos o não-estrago.
    expect(dec('a\\u00f3b')).toBe('a\\u00f3b');
    expect(dec('texto normal com acento óé')).toBe('texto normal com acento óé');
    expect(dec('sem nada a fazer aqui')).toBe('sem nada a fazer aqui');
  });

  it('NÃO reescreve hex fora da faixa de letras/pontuação (evita falso positivo)', () => {
    expect(dec('u0000')).toBe('u0000');
    expect(dec('valor u3042 japonês')).toBe('valor u3042 japonês'); // fora da faixa Latin/punct
    expect(dec('id ufeff')).toBe('id ufeff');
  });

  it('é idempotente', () => {
    expect(dec(dec('nu00e3o su00f3'))).toBe('não só');
  });

  it('recupera travessão e reticências achatados', () => {
    expect(dec('antesu2014depois')).toBe('antes—depois');
    expect(dec('esperandou2026')).toBe('esperando…');
  });
});
