// Dedupe da usage: linhas da mesma resposta (texto + tool_use) repetem o mesmo
// objeto `usage` e não podem ser somadas mais de uma vez.
import { describe, it, expect } from 'vitest';
import { usageKey } from '../src/stats/usageKey';

describe('usageKey', () => {
  it('dá a mesma chave para blocos da mesma resposta', () => {
    const a = { message: { id: 'msg_1' }, requestId: 'req_1' };
    const b = { message: { id: 'msg_1' }, requestId: 'req_1' };
    expect(usageKey(a)).toBe(usageKey(b));
  });

  it('separa respostas diferentes', () => {
    const a = { message: { id: 'msg_1' }, requestId: 'req_1' };
    const b = { message: { id: 'msg_2' }, requestId: 'req_2' };
    expect(usageKey(a)).not.toBe(usageKey(b));
  });

  it('mesma msg id em requests distintos conta separado', () => {
    const a = { message: { id: 'msg_1' }, requestId: 'req_1' };
    const b = { message: { id: 'msg_1' }, requestId: 'req_2' };
    expect(usageKey(a)).not.toBe(usageKey(b));
  });

  it('sem message.id não deduplica (conta a linha)', () => {
    expect(usageKey({ requestId: 'req_1' })).toBeUndefined();
    expect(usageKey({})).toBeUndefined();
  });
});
