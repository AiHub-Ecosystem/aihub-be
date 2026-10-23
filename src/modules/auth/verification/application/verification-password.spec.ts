import { createInMemoryAuthState } from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import {
  VERIFICATION_PASSWORD_ATTEMPTS,
  proveVerificationPassword,
} from './verification-password';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const STORED_HASH = 'argon2:registered password';

// A hasher that accepts exactly the password the registration used.
const hasher = {
  hash: async (password: string) => `argon2:${password}`,
  verify: async (password: string, encodedHash: string) =>
    `argon2:${password}` === encodedHash,
};

function pendingAccountWithToken(requiresPassword: boolean) {
  const state = createInMemoryAuthState();
  state.accounts.set('usr_1', {
    userId: 'usr_1',
    username: 'person_01',
    email: 'person@example.com',
    status: 'pending_verification',
    passwordHash: STORED_HASH,
  });
  state.verificationTokens.set('token-hash', {
    tokenId: 'evt_1',
    userId: 'usr_1',
    expiresAt: EXPIRES_AT,
    browserBindingHash: undefined,
    consumedAt: undefined,
    consumedReason: undefined,
    signedInAt: undefined,
    requiresPassword,
    passwordFailures: 0,
  });
  return { state, store: new InMemoryVerificationTokenAdapter(state) };
}

function prove(
  store: InMemoryVerificationTokenAdapter,
  password: string | undefined,
) {
  return proveVerificationPassword(
    { store, hasher },
    { tokenHash: 'token-hash', password, now: NOW },
  );
}

describe('proveVerificationPassword', () => {
  it('asks for nothing when the token is unknown, so consumption decides', async () => {
    const { store } = pendingAccountWithToken(true);

    await expect(
      proveVerificationPassword(
        { store, hasher },
        { tokenHash: 'unknown', password: undefined, now: NOW },
      ),
    ).resolves.toEqual({});
  });

  it('asks for nothing when the token does not need a password and none was sent', async () => {
    const { store } = pendingAccountWithToken(false);

    await expect(prove(store, undefined)).resolves.toEqual({});
  });

  it('refuses a token that needs the password when none was sent, without counting it', async () => {
    const { state, store } = pendingAccountWithToken(true);

    await expect(prove(store, undefined)).rejects.toMatchObject({
      code: 'AUTH_VERIFICATION_PASSWORD_INVALID',
      httpStatus: 400,
    });
    expect(state.verificationTokens.get('token-hash')?.passwordFailures).toBe(
      0,
    );
  });

  it('returns the verified hash for the registration password', async () => {
    const { store } = pendingAccountWithToken(true);

    await expect(prove(store, 'registered password')).resolves.toEqual({
      verifiedPasswordHash: STORED_HASH,
    });
  });

  it('refuses and counts a wrong password, even when the token does not need one', async () => {
    const { state, store } = pendingAccountWithToken(false);

    await expect(prove(store, 'a guess')).rejects.toMatchObject({
      code: 'AUTH_VERIFICATION_PASSWORD_INVALID',
    });
    expect(state.verificationTokens.get('token-hash')?.passwordFailures).toBe(
      1,
    );
  });

  it('spends the token on the fifth wrong password', async () => {
    const { state, store } = pendingAccountWithToken(true);

    for (
      let attempt = 0;
      attempt < VERIFICATION_PASSWORD_ATTEMPTS;
      attempt += 1
    ) {
      await expect(prove(store, 'a guess')).rejects.toMatchObject({
        code: 'AUTH_VERIFICATION_PASSWORD_INVALID',
      });
    }

    expect(state.verificationTokens.get('token-hash')).toMatchObject({
      consumedReason: 'password_attempts',
      passwordFailures: VERIFICATION_PASSWORD_ATTEMPTS,
    });
    await expect(prove(store, 'registered password')).resolves.toEqual({});
  });
});
