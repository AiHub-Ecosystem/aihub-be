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

function asDelivery(
  read: ReturnType<typeof readEmailPayload>,
): Exclude<ReturnType<typeof readEmailPayload>, string | undefined> {
  if (typeof read !== 'object') {
    throw new Error(`expected a delivery, got ${String(read)}`);
  }
  return read;
}

describe('readEmailPayload', () => {
  it('returns a delivery that holds the typed payload of a request it can open', () => {
    const read = asDelivery(
      readEmailPayload(sealed(VERIFICATION_PAYLOAD), claimed()),
    );

    expect(read.credential()).toMatchObject({
      token: VERIFICATION_PAYLOAD.token,
      expiresAt: VERIFICATION_PAYLOAD.expiresAt,
    });
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

  describe('a payload written by a newer release', () => {
    const INVITATION_PAYLOAD = {
      ...VERIFICATION_PAYLOAD,
      organizationName: 'Resonance',
      role: 'member',
    };
    const NEAR_EXPIRY_PAYLOAD = {
      organizationId: 'org_1',
      userAccountId: 'usr_1',
      apiKeyIds: ['key_1'],
    };
    const MFA_PAYLOAD = { email: 'person@example.com' };

    function cipherOf(value: unknown): EmailPayloadCipherPort {
      return {
        encrypt: (): string => 'sealed',
        decrypt: (): string => JSON.stringify(value),
      };
    }

    it.each([
      ['verification_email', VERIFICATION_PAYLOAD],
      ['password_reset_email', VERIFICATION_PAYLOAD],
      ['organization_invite_email', INVITATION_PAYLOAD],
      ['mfa_enabled_notification', MFA_PAYLOAD],
      ['mfa_removed_notification', MFA_PAYLOAD],
      ['api_key_near_expiry_notification', NEAR_EXPIRY_PAYLOAD],
    ] as const)(
      'is readable for %s when it carries a member this release does not know',
      (kind, payload) => {
        expect(() =>
          asDelivery(
            readEmailPayload(
              cipherOf({ ...payload, addedLater: { nested: true } }),
              claimed({ kind }),
            ),
          ),
        ).not.toThrow();
      },
    );

    it.each([
      ['mfa_enabled_notification', { email: 42, addedLater: true }],
      [
        'api_key_near_expiry_notification',
        { ...NEAR_EXPIRY_PAYLOAD, apiKeyIds: [1], addedLater: true },
      ],
      [
        'organization_invite_email',
        { ...INVITATION_PAYLOAD, organizationName: 7, addedLater: true },
      ],
    ] as const)(
      'is still unreadable for %s when a member it knows has the wrong type',
      (kind, payload) => {
        expect(readEmailPayload(cipherOf(payload), claimed({ kind }))).toBe(
          'unreadable',
        );
      },
    );

    it('is unrecognised, not unreadable, when an invitation names a role this release does not know', () => {
      expect(
        readEmailPayload(
          cipherOf({ ...INVITATION_PAYLOAD, role: 'auditor' }),
          claimed({ kind: 'organization_invite_email' }),
        ),
      ).toBe('unrecognised');
    });

    it.each([
      ['a role that is not a string', { ...INVITATION_PAYLOAD, role: 42 }],
      ['a missing role', { ...INVITATION_PAYLOAD, role: undefined }],
      [
        'an unknown role beside another invalid member',
        { ...INVITATION_PAYLOAD, role: 'auditor', organizationName: '' },
      ],
    ])('stays unreadable for %s', (_name, payload) => {
      expect(
        readEmailPayload(
          cipherOf(payload),
          claimed({ kind: 'organization_invite_email' }),
        ),
      ).toBe('unreadable');
    });
  });

  it('distinguishes a key version the instance does not hold from unreadable ciphertext', () => {
    expect(readEmailPayload(unknownKeyVersionCipher(), claimed())).toBe(
      'key_unavailable',
    );
  });
});
