import { createCipheriv, randomBytes } from 'node:crypto';

import { createEmailPayloadCipher } from './email-payload-cipher';

const KEY_ID = '2026-10';
const KEY = Buffer.alloc(32, 7).toString('base64');
const ROW = {
  id: 'edr_01J00000000000000000000001',
  kind: 'verification_email',
} as const;
const OTHER_ROW = {
  id: 'edr_01J00000000000000000000002',
  kind: 'verification_email',
} as const;

function cipherWith(keys: Record<string, string>, currentKeyId: string) {
  return createEmailPayloadCipher({ currentKeyId, keys });
}

/**
 * An envelope sealed by hand, so these specs pin the wire format rather than
 * the cipher under test: `v1` carries no associated data, `v2` authenticates
 * the request it belongs to. The reader has to open `v2` before any instance is
 * allowed to write it.
 */
function seal(
  version: 'v1' | 'v2',
  plaintext: string,
  context?: { readonly id: string; readonly kind: string },
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), iv);
  if (context !== undefined) {
    cipher.setAAD(Buffer.from(`${context.id}\n${context.kind}`, 'utf8'));
  }
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    version,
    KEY_ID,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

const UNREADABLE = { name: 'EnvelopeCipherError', kind: 'unreadable' };

describe('the email payload envelope can bind a payload to its request', () => {
  const cipher = cipherWith({ [KEY_ID]: KEY }, KEY_ID);

  it('opens a bound envelope on the row and kind it was sealed for', () => {
    const envelope = seal('v2', '{"email":"person@example.com"}', ROW);

    expect(cipher.decrypt(envelope, ROW)).toBe(
      '{"email":"person@example.com"}',
    );
  });

  it('does not open a bound envelope on another row', () => {
    const envelope = seal('v2', 'payload', ROW);

    expect(thrownBy(() => cipher.decrypt(envelope, OTHER_ROW))).toMatchObject(
      UNREADABLE,
    );
  });

  it('does not open a bound envelope as another kind', () => {
    const envelope = seal('v2', 'payload', ROW);

    expect(
      thrownBy(() =>
        cipher.decrypt(envelope, { ...ROW, kind: 'password_reset_email' }),
      ),
    ).toMatchObject(UNREADABLE);
  });

  it('does not open a bound envelope whose ciphertext was altered', () => {
    const parts = seal('v2', 'payload', ROW).split('.');
    parts[4] = Buffer.from('forged-ciphertext').toString('base64url');

    expect(thrownBy(() => cipher.decrypt(parts.join('.'), ROW))).toMatchObject(
      UNREADABLE,
    );
  });

  it('does not open a bound envelope under a key id that now holds other material', () => {
    const envelope = seal('v2', 'payload', ROW);
    const reprovisioned = cipherWith(
      { [KEY_ID]: Buffer.alloc(32, 8).toString('base64') },
      KEY_ID,
    );

    expect(thrownBy(() => reprovisioned.decrypt(envelope, ROW))).toMatchObject(
      UNREADABLE,
    );
  });

  it('keeps reporting an unknown key version as unknown, not as unreadable', () => {
    const envelope = seal('v2', 'payload', ROW);
    const rotatedAway = cipherWith(
      { '2026-11': Buffer.alloc(32, 9).toString('base64') },
      '2026-11',
    );

    expect(() => rotatedAway.decrypt(envelope, ROW)).toThrow(
      'email outbox key version is unknown',
    );
  });

  it('still opens an envelope written before the binding existed, on any row', () => {
    const legacy = seal('v1', 'legacy payload');

    expect(cipher.decrypt(legacy, ROW)).toBe('legacy payload');
    expect(cipher.decrypt(legacy, OTHER_ROW)).toBe('legacy payload');
  });

  it('seals in the format every instance can already read', () => {
    const envelope = cipher.encrypt('payload', ROW);

    expect(envelope.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(envelope, OTHER_ROW)).toBe('payload');
  });
});
