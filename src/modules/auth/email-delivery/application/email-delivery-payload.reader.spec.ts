import { readEmailPayload } from './email-delivery-payload.reader';
import {
  VERIFICATION_PAYLOAD,
  claimed,
  sealed,
  unknownKeyVersionCipher,
} from './email-delivery-poller.spec-support';
import { EnvelopeCipherError } from './email-delivery-request.port';
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

  it('rejects near-expiry notice payloads with extra properties', () => {
    const cipher: EmailPayloadCipherPort = {
      encrypt: (): string => 'sealed',
      decrypt: (): string =>
        JSON.stringify({
          organizationId: 'org_1',
          userAccountId: 'usr_1',
          apiKeyIds: ['key_1'],
          extra: true,
        }),
    };

    expect(
      readEmailPayload(
        cipher,
        claimed({ kind: 'api_key_near_expiry_notification' }),
      ),
    ).toBe('unreadable');
  });

  it('distinguishes a key version the instance does not hold from unreadable ciphertext', () => {
    expect(readEmailPayload(unknownKeyVersionCipher(), claimed())).toBe(
      'key_unavailable',
    );
  });
});
