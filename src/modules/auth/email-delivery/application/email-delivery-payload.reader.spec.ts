import { readEmailPayload } from './email-delivery-payload.reader';
import {
  VERIFICATION_PAYLOAD,
  claimed,
  sealed,
  unknownKeyVersionCipher,
} from './email-delivery-poller.spec-support';
import {
  EmailPayloadUnknownKeyVersionError,
  EnvelopeCipherError,
} from './email-delivery-request.port';
import type { EmailPayloadCipherPort } from './email-delivery-request.port';

function cipherThrowing(error: Error): EmailPayloadCipherPort {
  return {
    encrypt: (): string => 'sealed',
    decrypt: () => {
      throw error;
    },
  };
}

describe('readEmailPayload', () => {
  it('returns the handler and payload of a request it can open', () => {
    const read = readEmailPayload(sealed(VERIFICATION_PAYLOAD), claimed());

    expect(read).toMatchObject({ payload: VERIFICATION_PAYLOAD });
    expect(read).not.toBe('unreadable');
  });

  it('answers nothing for a payload that was already erased', () => {
    expect(
      readEmailPayload(sealed(VERIFICATION_PAYLOAD), {
        ...claimed(),
        payloadCiphertext: null,
      }),
    ).toBeUndefined();
  });

  it('passes the request id and kind to the cipher, which binds them', () => {
    const contexts: unknown[] = [];
    const cipher: EmailPayloadCipherPort = {
      encrypt: (): string => 'sealed',
      decrypt: (_envelope, context) => {
        contexts.push(context);
        return JSON.stringify(VERIFICATION_PAYLOAD);
      },
    };

    readEmailPayload(
      cipher,
      claimed({ id: 'edr_row', kind: 'password_reset_email' }),
    );

    expect(contexts).toEqual([{ id: 'edr_row', kind: 'password_reset_email' }]);
  });

  it.each([
    [
      'an envelope that fails authentication',
      new EnvelopeCipherError('unreadable', 'x'),
    ],
    ['a malformed envelope', new EnvelopeCipherError('malformed', 'x')],
    ['an error that is not a cipher error', new Error('boom')],
  ])('is unreadable for %s', (_name, error) => {
    expect(readEmailPayload(cipherThrowing(error), claimed())).toBe(
      'unreadable',
    );
  });

  it('is unreadable for plaintext that is not JSON', () => {
    const cipher: EmailPayloadCipherPort = {
      encrypt: (): string => 'sealed',
      decrypt: (): string => 'not json',
    };

    expect(readEmailPayload(cipher, claimed())).toBe('unreadable');
  });

  it('is unreadable for JSON that is not the shape its kind needs', () => {
    expect(
      readEmailPayload(sealed({ email: 'person@example.com' }), claimed()),
    ).toBe('unreadable');
  });

  it('rethrows an unknown key version, so the row stays queued for an instance that holds the key', () => {
    expect(() =>
      readEmailPayload(unknownKeyVersionCipher(), claimed()),
    ).toThrow(EmailPayloadUnknownKeyVersionError);
  });
});
