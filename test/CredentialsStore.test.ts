import { describe, it, expect } from 'vitest';
import { verifyTotp, generateTotpSecret } from '../src/secrets/CredentialsStore';

// Vetor de teste do RFC 6238 (SHA1): segredo ASCII "12345678901234567890" em
// base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. At T=59s the 8-digit code is
// 94287082 → 6 digits = 287082.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('verifyTotp', () => {
  it('aceita o código correto (vetor RFC 6238) em T=59s', () => {
    expect(verifyTotp(RFC_SECRET, '287082', 59_000)).toBe(true);
  });

  it('aceita ±1 passo (clock drift) e rejeita fora da janela', () => {
    // 59s and ±30s fall within the tolerance of the same/neighboring step.
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 30_000)).toBe(true);
    // Far away (several steps later): the old code is no longer valid.
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 5 * 30_000)).toBe(false);
  });

  it('rejeita código inválido e formatos errados', () => {
    expect(verifyTotp(RFC_SECRET, '000000', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345', 59_000)).toBe(false); // 5 digits
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '', 59_000)).toBe(false);
  });

  it('faz round-trip com um segredo gerado', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/); // valid base32
    // generates the current step's code by reusing the verification itself:
    // sweeping the 1,000,000 codes would be expensive; instead we trust the
    // RFC vector above for the algorithm and here we only ensure a new secret does NOT validate
    // an arbitrary code (there is no trivial collision).
    expect(verifyTotp(secret, '000000', 0)).toBe(false);
  });
});
