import { describe, it, expect } from 'vitest';
import { StreamParser } from '../src/cli/StreamParser';

describe('StreamParser', () => {
  it('parseia uma linha NDJSON completa', () => {
    const p = new StreamParser();
    const evs = p.push('{"type":"system","subtype":"init","session_id":"s1"}\n');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'system', subtype: 'init', session_id: 's1' });
  });

  it('parseia múltiplas linhas em um único chunk', () => {
    const p = new StreamParser();
    const evs = p.push('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
    expect(evs.map((e) => e.type)).toEqual(['a', 'b', 'c']);
  });

  it('mantém linha parcial no buffer entre chunks', () => {
    const p = new StreamParser();
    expect(p.push('{"type":"assi')).toEqual([]);
    expect(p.push('stant"}\n')).toEqual([{ type: 'assistant' }]);
  });

  it('lida com objeto dividido em três chunks', () => {
    const p = new StreamParser();
    expect(p.push('{"ty')).toEqual([]);
    expect(p.push('pe":"x","n":')).toEqual([]);
    expect(p.push('1}\n')).toEqual([{ type: 'x', n: 1 }]);
  });

  it('ignora linhas em branco e espaços', () => {
    const p = new StreamParser();
    const evs = p.push('\n   \n{"type":"ok"}\n\n');
    expect(evs).toEqual([{ type: 'ok' }]);
  });

  it('descarta linhas com JSON inválido sem quebrar (ruído de log do CLI)', () => {
    const p = new StreamParser();
    const evs = p.push('not json\n{"type":"good"}\nDEBUG: foo {bar\n');
    expect(evs).toEqual([{ type: 'good' }]);
  });

  it('descarta JSON válido sem campo type string', () => {
    const p = new StreamParser();
    expect(p.push('{"foo":1}\n')).toEqual([]);
    expect(p.push('[1,2,3]\n')).toEqual([]);
    expect(p.push('42\n')).toEqual([]);
    expect(p.push('"texto"\n')).toEqual([]);
    expect(p.push('null\n')).toEqual([]);
    expect(p.push('{"type":123}\n')).toEqual([]); // type não-string
  });

  it('aceita eventos de tipo desconhecido (tolerância de versão)', () => {
    const p = new StreamParser();
    const evs = p.push('{"type":"evento_futuro_v99","payload":{"x":1}}\n');
    expect(evs[0]).toMatchObject({ type: 'evento_futuro_v99' });
  });

  it('trata \\r\\n (CRLF) corretamente via trim', () => {
    const p = new StreamParser();
    const evs = p.push('{"type":"crlf"}\r\n');
    expect(evs).toEqual([{ type: 'crlf' }]);
  });

  it('flush emite o resto do buffer sem newline final', () => {
    const p = new StreamParser();
    expect(p.push('{"type":"sem_nl"}')).toEqual([]);
    expect(p.flush()).toEqual([{ type: 'sem_nl' }]);
  });

  it('flush com buffer vazio retorna lista vazia', () => {
    const p = new StreamParser();
    expect(p.flush()).toEqual([]);
  });

  it('flush com resto inválido retorna lista vazia', () => {
    const p = new StreamParser();
    p.push('lixo sem newline');
    expect(p.flush()).toEqual([]);
  });

  it('flush limpa o buffer (segunda chamada vazia)', () => {
    const p = new StreamParser();
    p.push('{"type":"x"}');
    expect(p.flush()).toEqual([{ type: 'x' }]);
    expect(p.flush()).toEqual([]);
  });

  it('preserva conteúdo com newline escapado dentro de string JSON', () => {
    const p = new StreamParser();
    const evs = p.push('{"type":"text","text":"linha1\\nlinha2"}\n');
    expect(evs[0]).toMatchObject({ type: 'text', text: 'linha1\nlinha2' });
  });
});
