import { createHash, createHmac, randomBytes } from 'node:crypto';

import { constantTimeEquals } from '@/common/security/constant-time-equals';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_MS = 30_000;
const TOTP_DIGITS = 6;
const RECOVERY_CODE_COUNT = 8;

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function verifyTotp(secret: string, code: string, now: Date): boolean {
  if (!/^\d{6}$/u.test(code)) return false;
  const key = decodeBase32(secret);
  const counter = Math.floor(now.getTime() / TOTP_STEP_MS);
  let matches = false;
  for (const offset of [-1, 0, 1]) {
    matches =
      constantTimeEquals(totpAt(key, counter + offset), code) || matches;
  }
  return matches;
}

export function generateMfaRecoveryCodes(): readonly string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const encoded = encodeBase32(randomBytes(10));
    return encoded.match(/.{4}/gu)?.join('-') ?? encoded;
  });
}

export function hashMfaRecoveryCode(code: string): string {
  const normalized = code.replaceAll('-', '').trim().toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}

function totpAt(secret: Buffer, counter: number): string {
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(movingFactor).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function encodeBase32(value: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      encoded += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) encoded += BASE32[(buffer << (5 - bits)) & 31];
  return encoded;
}

function decodeBase32(value: string): Buffer {
  if (!/^[A-Z2-7]+$/u.test(value)) throw new Error('TOTP secret is invalid');
  let bits = 0;
  let buffer = 0;
  const decoded: number[] = [];
  for (const character of value) {
    buffer = (buffer << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      decoded.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(decoded);
}
