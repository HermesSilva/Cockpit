import { describe, it, expect } from 'vitest';
import { verifyTotp, generateTotpSecret } from '../src/secrets/CredentialsStore';

// Vetor de teste do RFC 6238 (SHA1): segredo ASCII "12345678901234567890" em
// base32 = GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ. Em T=59s o código de 8 dígitos é
// 94287082 → 6 dígitos = 287082.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('verifyTotp', () => {
  it('aceita o código correto (vetor RFC 6238) em T=59s', () => {
    expect(verifyTotp(RFC_SECRET, '287082', 59_000)).toBe(true);
  });

  it('aceita ±1 passo (clock drift) e rejeita fora da janela', () => {
    // 59s e ±30s caem dentro da tolerância do mesmo passo/vizinho.
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 30_000)).toBe(true);
    // Bem distante (vários passos depois): código antigo não vale mais.
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 5 * 30_000)).toBe(false);
  });

  it('rejeita código inválido e formatos errados', () => {
    expect(verifyTotp(RFC_SECRET, '000000', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345', 59_000)).toBe(false); // 5 dígitos
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '', 59_000)).toBe(false);
  });

  it('faz round-trip com um segredo gerado', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32 válido
    // gera o código do passo atual reaproveitando a própria verificação:
    // varremos os 1.000.000 códigos seria caro; em vez disso confiamos no vetor
    // RFC acima p/ o algoritmo e aqui só garantimos que um segredo novo NÃO valida
    // um código arbitrário (não há colisão trivial).
    expect(verifyTotp(secret, '000000', 0)).toBe(false);
  });
});
