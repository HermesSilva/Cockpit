// Cofre de credenciais protegido por TOTP (2FA). Os valores ficam no
// SecretStorage nativo do VSCode (keychain/credential manager do SO) — nunca em
// texto plano, nunca logado. Toda operação sensível (adicionar/usar/remover) exige
// um código TOTP válido, gerado por um autenticador (Google Authenticator/Authy)
// que o usuário enrola via QR. O enrollment guarda só o segredo TOTP do cofre.
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';

// Chaves no SecretStorage. Tudo aqui é cifrado pelo SO.
const K_TOTP = 'cockpit.creds.totp'; // segredo TOTP do cofre (base32) — presença = enrolado
const K_INDEX = 'cockpit.creds.index'; // JSON com os metadados (sem valores)
const K_VALUE = (id: string) => `cockpit.creds.v.${id}`; // valor de cada credencial

/** Metadados de uma credencial (nunca inclui o valor secreto). */
export interface CredentialMeta {
  id: string;
  name: string;
  username?: string;
  note?: string;
  createdAt: number;
}

// --- TOTP (RFC 6238) -------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue; // ignora caracteres inválidos (tolerante)
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Gera um segredo TOTP novo (20 bytes aleatórios em base32). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** Calcula o código TOTP de 6 dígitos para um contador (passo de 30s). */
function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}

/** Verifica um código TOTP, aceitando ±1 passo (tolerância a clock drift). */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  const clean = (code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const step = Math.floor(atMs / 1000 / 30);
  for (let w = -1; w <= 1; w++) {
    const counter = step + w;
    if (counter < 0) continue; // passo negativo (relógio ~época) não existe
    // Comparação de tempo constante p/ não vazar via timing.
    const expected = hotp(secret, counter);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** URI otpauth:// para o autenticador (label do cofre + issuer). */
function otpauthUri(secret: string): string {
  const label = encodeURIComponent('Tootega Cockpit:cofre');
  const issuer = encodeURIComponent('Tootega Cockpit');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

// --- Cofre -----------------------------------------------------------------

export class CredentialsStore {
  // Segredo TOTP gerado mas ainda NÃO confirmado (aguarda o 1º código válido).
  // Fica só em memória; só vira enrollment ao confirmar.
  private pendingTotp?: string;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  /** Já há um autenticador enrolado no cofre? */
  async isEnrolled(): Promise<boolean> {
    return !!(await this.secrets.get(K_TOTP));
  }

  /** Metadados de todas as credenciais (sem valores). */
  async list(): Promise<CredentialMeta[]> {
    const raw = await this.secrets.get(K_INDEX);
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw) as CredentialMeta[];
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private async saveIndex(items: CredentialMeta[]): Promise<void> {
    await this.secrets.store(K_INDEX, JSON.stringify(items));
  }

  /** Inicia o enrollment: gera segredo, devolve QR (SVG) + segredo + URI. */
  async beginEnroll(): Promise<{ qrSvg: string; secret: string; uri: string }> {
    const secret = generateTotpSecret();
    this.pendingTotp = secret;
    const uri = otpauthUri(secret);
    const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 180 });
    return { qrSvg, secret, uri };
  }

  /** Confirma o enrollment com o 1º código do autenticador. */
  async confirmEnroll(code: string): Promise<boolean> {
    const secret = this.pendingTotp;
    if (!secret || !verifyTotp(secret, code)) return false;
    await this.secrets.store(K_TOTP, secret);
    this.pendingTotp = undefined;
    return true;
  }

  /** Verifica um código contra o segredo enrolado. */
  private async verify(code: string): Promise<boolean> {
    const secret = await this.secrets.get(K_TOTP);
    if (!secret) return false;
    return verifyTotp(secret, code);
  }

  /** Adiciona uma credencial (requer código TOTP válido). */
  async add(
    code: string,
    data: { name: string; username?: string; value: string; note?: string },
  ): Promise<{ ok: boolean; reason?: 'totp' | 'input' }> {
    if (!(await this.verify(code))) return { ok: false, reason: 'totp' };
    const name = data.name?.trim();
    const value = data.value ?? '';
    if (!name || !value) return { ok: false, reason: 'input' };
    const id = crypto.randomBytes(8).toString('hex');
    const items = await this.list();
    items.push({
      id,
      name,
      username: data.username?.trim() || undefined,
      note: data.note?.trim() || undefined,
      createdAt: Date.now(),
    });
    await this.secrets.store(K_VALUE(id), value);
    await this.saveIndex(items);
    return { ok: true };
  }

  /** Edita uma credencial (requer código TOTP válido). value ausente = mantém. */
  async edit(
    code: string,
    id: string,
    data: { name: string; username?: string; value?: string; note?: string },
  ): Promise<{ ok: boolean; reason?: 'totp' | 'input' }> {
    if (!(await this.verify(code))) return { ok: false, reason: 'totp' };
    const name = data.name?.trim();
    if (!name) return { ok: false, reason: 'input' };
    const items = await this.list();
    const idx = items.findIndex((c) => c.id === id);
    if (idx < 0) return { ok: false, reason: 'input' };
    items[idx] = {
      ...items[idx],
      name,
      username: data.username?.trim() || undefined,
      note: data.note?.trim() || undefined,
    };
    // Só reescreve o valor se um novo foi informado (campo vazio = manter).
    if (typeof data.value === 'string' && data.value.length > 0) {
      await this.secrets.store(K_VALUE(id), data.value);
    }
    await this.saveIndex(items);
    return { ok: true };
  }

  /** Recupera o valor de uma credencial (requer código TOTP válido). */
  async use(code: string, id: string): Promise<{ ok: boolean; value?: string; reason?: 'totp' }> {
    if (!(await this.verify(code))) return { ok: false, reason: 'totp' };
    const value = await this.secrets.get(K_VALUE(id));
    return { ok: true, value: value ?? '' };
  }

  /** Remove uma credencial (requer código TOTP válido). */
  async remove(code: string, id: string): Promise<{ ok: boolean; reason?: 'totp' }> {
    if (!(await this.verify(code))) return { ok: false, reason: 'totp' };
    await this.secrets.delete(K_VALUE(id));
    const items = (await this.list()).filter((c) => c.id !== id);
    await this.saveIndex(items);
    return { ok: true };
  }
}
