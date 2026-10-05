import { createEmailPayloadCipher } from './email-payload-cipher';

function keyId(id: string, seed = 0): string {
  return Buffer.alloc(32, seed).toString('base64');
}

describe('createEmailPayloadCipher', () => {
  it('round-trips an email delivery payload', () => {
    const cipher = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: { '2026-10': keyId('k1', 1) },
    });

    const envelope = cipher.encrypt('{"email":"person@example.com"}');

    expect(cipher.decrypt(envelope)).toBe('{"email":"person@example.com"}');
  });

  it('decrypts envelopes sealed under a retained older key version', () => {
    const old = createEmailPayloadCipher({
      currentKeyId: '2026-09',
      keys: { '2026-09': Buffer.alloc(32, 9).toString('base64') },
    });
    const envelope = old.encrypt('payload');

    const rotated = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: {
        '2026-09': Buffer.alloc(32, 9).toString('base64'),
        '2026-10': Buffer.alloc(32, 10).toString('base64'),
      },
    });

    expect(rotated.decrypt(envelope)).toBe('payload');
  });

  it('fails authentication when the envelope is tampered with', () => {
    const cipher = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: { '2026-10': Buffer.alloc(32, 1).toString('base64') },
    });
    const envelope = cipher.encrypt('payload');
    const parts = envelope.split('.');
    parts[4] = Buffer.from('forged-ciphertext').toString('base64url');

    expect(() => cipher.decrypt(parts.join('.'))).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
  });

  it('fails when the key version is unknown', () => {
    const cipher = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: { '2026-10': Buffer.alloc(32, 1).toString('base64') },
    });

    expect(() => cipher.decrypt('v1.2099-01.aa.bb.cc')).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
  });

  it('fails authentication when a different key seals the envelope', () => {
    const sealed = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: { '2026-10': Buffer.alloc(32, 1).toString('base64') },
    }).encrypt('payload');
    const wrongKey = createEmailPayloadCipher({
      currentKeyId: '2026-10',
      keys: { '2026-10': Buffer.alloc(32, 2).toString('base64') },
    });

    expect(() => wrongKey.decrypt(sealed)).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
  });

  it('rejects missing or malformed key material at construction', () => {
    expect(() =>
      createEmailPayloadCipher({ currentKeyId: '2026-10', keys: {} }),
    ).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
    expect(() =>
      createEmailPayloadCipher({
        currentKeyId: '2026-10',
        keys: { '2026-10': 'not-base64-key-material' },
      }),
    ).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
    expect(() =>
      createEmailPayloadCipher({
        currentKeyId: '2026-10',
        keys: { '2026-09': Buffer.alloc(32, 1).toString('base64') },
      }),
    ).toThrow(
      /authenticate|malformed|unknown|missing|invalid|provisioned|unavailable/,
    );
  });
});
