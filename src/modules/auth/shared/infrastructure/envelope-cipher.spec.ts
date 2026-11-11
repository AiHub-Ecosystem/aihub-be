import { EnvelopeCipherError } from '@/modules/auth/email-delivery/application/email-delivery-request.port';
import {
  EnvelopeCipher,
  type EnvelopeCipherMessages,
  type EnvelopeKeyring,
  type EnvelopeLayout,
} from './envelope-cipher';

const CURRENT_KEY_ID = 'current_key-1';
const CURRENT_KEY = Buffer.alloc(32, 1).toString('base64');
const RETAINED_KEY_ID = 'retained-key-1';
const RETAINED_KEY = Buffer.alloc(32, 2).toString('base64');
const AAD = Buffer.from('record-1\nverification_email');

const MESSAGES: EnvelopeCipherMessages = {
  keyring: 'invalid keyring',
  keyId: 'invalid key id',
  keyMaterial: 'invalid key material',
  currentKey: 'invalid current key',
  missingKeys: 'missing keys',
  currentNotProvisioned: 'current key is not provisioned',
  malformed: 'malformed envelope',
  unknownKey: 'unknown key',
  unreadable: 'unreadable envelope',
};

function cipher(
  layout: EnvelopeLayout,
  keyring: EnvelopeKeyring = {
    currentKeyId: CURRENT_KEY_ID,
    keys: { [CURRENT_KEY_ID]: CURRENT_KEY },
  },
  version = 'v2',
): EnvelopeCipher {
  return new EnvelopeCipher(keyring, layout, version, MESSAGES);
}

function captureCipherError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('EnvelopeCipher self-describing envelopes', () => {
  it('writes a version and key id and opens the authenticated payload', () => {
    const subject = cipher('self-describing');
    const envelope = subject.seal('payload', AAD);

    expect(envelope.split('.')).toHaveLength(5);
    expect(envelope.split('.').slice(0, 2)).toEqual(['v2', CURRENT_KEY_ID]);
    expect(subject.open(envelope, undefined, AAD)).toBe('payload');
  });

  it('opens an envelope using a retained key after rotation', () => {
    const oldKey = cipher('self-describing', {
      currentKeyId: RETAINED_KEY_ID,
      keys: { [RETAINED_KEY_ID]: RETAINED_KEY },
    });
    const retained = cipher('self-describing', {
      currentKeyId: CURRENT_KEY_ID,
      keys: {
        [CURRENT_KEY_ID]: CURRENT_KEY,
        [RETAINED_KEY_ID]: RETAINED_KEY,
      },
    });

    expect(retained.open(oldKey.seal('old payload'), undefined)).toBe(
      'old payload',
    );
  });

  it.each([
    'wrong.id.count',
    'v1.key-id.iv.tag.ciphertext',
    'v2.key-id.iv.tag.ciphertext.extra',
  ])('rejects an envelope with invalid structure or version: %s', (value) => {
    const error = captureCipherError(() =>
      cipher('self-describing').open(value, undefined),
    );
    expect(error).toBeInstanceOf(EnvelopeCipherError);
    expect(error).toMatchObject({ kind: 'malformed' });
  });

  it('distinguishes a well-formed envelope that names an unknown key', () => {
    expect(
      captureCipherError(() =>
        cipher('self-describing').open(
          'v2.missing-key.iv.tag.ciphertext',
          undefined,
        ),
      ),
    ).toMatchObject({ kind: 'unknown-key' });
  });

  it('rejects modified authentication data and ciphertext', () => {
    const subject = cipher('self-describing');
    const envelope = subject.seal('payload').split('.');
    const modifiedTag = [...envelope];
    modifiedTag[3] = Buffer.alloc(16, 7).toString('base64url');
    const modifiedCiphertext = [...envelope];
    modifiedCiphertext[4] = Buffer.from('forged').toString('base64url');

    expect(
      captureCipherError(() => subject.open(modifiedTag.join('.'), undefined)),
    ).toMatchObject({ kind: 'unreadable' });
    expect(
      captureCipherError(() =>
        subject.open(modifiedCiphertext.join('.'), undefined),
      ),
    ).toMatchObject({ kind: 'unreadable' });
  });

  it('authenticates optional associated data', () => {
    const subject = cipher('self-describing');
    const envelope = subject.seal('payload', AAD);

    expect(subject.open(envelope, undefined, AAD)).toBe('payload');
    expect(
      captureCipherError(() =>
        subject.open(envelope, undefined, Buffer.from('another record')),
      ),
    ).toMatchObject({ kind: 'unreadable' });
  });
});

describe('EnvelopeCipher compact envelopes', () => {
  it('writes three segments and opens with the external key id', () => {
    const subject = cipher('compact');
    const envelope = subject.seal('payload', AAD);

    expect(envelope.split('.')).toHaveLength(3);
    expect(subject.open(envelope, CURRENT_KEY_ID, AAD)).toBe('payload');
  });

  it('rejects a missing external key id and malformed segment counts', () => {
    const subject = cipher('compact');

    expect(
      captureCipherError(() => subject.open('iv.tag.ciphertext', undefined)),
    ).toMatchObject({ kind: 'malformed' });
    expect(
      captureCipherError(() => subject.open('iv.tag', CURRENT_KEY_ID)),
    ).toMatchObject({ kind: 'malformed' });
    expect(
      captureCipherError(() =>
        subject.open('iv.tag.ciphertext.extra', CURRENT_KEY_ID),
      ),
    ).toMatchObject({ kind: 'malformed' });
  });

  it('distinguishes an external key id that is not provisioned', () => {
    expect(
      captureCipherError(() =>
        cipher('compact').open('iv.tag.ciphertext', 'missing-key'),
      ),
    ).toMatchObject({ kind: 'unknown-key' });
  });

  it('rejects modified authentication data', () => {
    const subject = cipher('compact');
    const envelope = subject.seal('payload').split('.');
    envelope[1] = Buffer.alloc(16, 3).toString('base64url');

    expect(
      captureCipherError(() =>
        subject.open(envelope.join('.'), CURRENT_KEY_ID),
      ),
    ).toMatchObject({ kind: 'unreadable' });
  });
});

describe('EnvelopeCipher keyring validation', () => {
  it('accepts key ids at the one and 64 character boundaries', () => {
    expect(() =>
      cipher('self-describing', {
        currentKeyId: 'k',
        keys: { k: CURRENT_KEY },
      }),
    ).not.toThrow();
    expect(() =>
      cipher('self-describing', {
        currentKeyId: 'k'.repeat(64),
        keys: { ['k'.repeat(64)]: CURRENT_KEY },
      }),
    ).not.toThrow();
  });

  it.each(['.valid', 'valid.', 'invalid!', 'k'.repeat(65)])(
    'rejects an invalid retained key id: %s',
    (id) => {
      expect(
        captureCipherError(() =>
          cipher('self-describing', {
            currentKeyId: id,
            keys: { [id]: CURRENT_KEY },
          }),
        ),
      ).toMatchObject({ kind: 'malformed' });
    },
  );

  it('rejects an empty keyring', () => {
    expect(
      captureCipherError(() =>
        cipher('self-describing', { currentKeyId: CURRENT_KEY_ID, keys: {} }),
      ),
    ).toMatchObject({ kind: 'malformed', message: 'missing keys' });
  });

  it.each([
    ['wrong length', Buffer.alloc(31, 3).toString('base64')],
    ['non-canonical base64', `${CURRENT_KEY}\n`],
  ])('rejects %s key material', (_description, encoded) => {
    expect(
      captureCipherError(() =>
        cipher('self-describing', {
          currentKeyId: CURRENT_KEY_ID,
          keys: { [CURRENT_KEY_ID]: encoded },
        }),
      ),
    ).toMatchObject({ kind: 'malformed' });
  });

  it('requires the current key id to be valid and provisioned', () => {
    expect(
      captureCipherError(() =>
        cipher('self-describing', {
          currentKeyId: '',
          keys: { [CURRENT_KEY_ID]: CURRENT_KEY },
        }),
      ),
    ).toMatchObject({ kind: 'malformed', message: 'invalid key id' });
    expect(
      captureCipherError(() =>
        cipher('self-describing', {
          currentKeyId: 'invalid!',
          keys: { [CURRENT_KEY_ID]: CURRENT_KEY },
        }),
      ),
    ).toMatchObject({ kind: 'malformed', message: 'invalid key id' });
    expect(
      captureCipherError(() =>
        cipher('self-describing', {
          currentKeyId: 'missing-key',
          keys: { [CURRENT_KEY_ID]: CURRENT_KEY },
        }),
      ),
    ).toMatchObject({ kind: 'malformed' });
  });

  it('rejects an invalid retained key even when the current key is valid', () => {
    expect(
      captureCipherError(() =>
        cipher('self-describing', {
          currentKeyId: CURRENT_KEY_ID,
          keys: { [CURRENT_KEY_ID]: CURRENT_KEY, 'bad.id': RETAINED_KEY },
        }),
      ),
    ).toMatchObject({ kind: 'malformed' });
  });
});
