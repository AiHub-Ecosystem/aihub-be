import {
  createInMemoryAuthState,
  seedAccount as seedAccountHelper,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import {
  type VerificationTokenContractHarness,
  verificationTokenRepositoryContract,
} from '@/modules/auth/testing/verification-token.contract';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EXPIRED_AT = new Date('2026-09-22T00:00:00.000Z');
const EMAIL = 'verify@example.com';
const BINDING = 'a'.repeat(64);
const USER_ID = 'usr_1';
const PASSWORD_HASH = 'hash';

let state = createInMemoryAuthState();
let repo: InMemoryVerificationTokenAdapter;

verificationTokenRepositoryContract({
  userId: USER_ID,
  email: EMAIL,
  binding: BINDING,
  now: NOW,
  expiresAt: EXPIRES_AT,
  expiredAt: EXPIRED_AT,
  passwordHash: PASSWORD_HASH,
  createRepo: () => {
    repo = new InMemoryVerificationTokenAdapter(state);
    return repo;
  },
  reset: async () => {
    state.reset();
  },
  seedAccount: async (status) => {
    seedAccountHelper(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: PASSWORD_HASH,
      status,
    });
  },
  insertToken: async (
    options: Parameters<VerificationTokenContractHarness['insertToken']>[0],
  ) => {
    state.verificationTokens.set(options.hash, {
      tokenId: options.hash,
      userId: USER_ID,
      expiresAt: options.expiresAt ?? EXPIRES_AT,
      browserBindingHash: options.bindingHash,
      consumedAt: options.consumedAt,
      consumedReason: options.consumedReason,
      signedInAt: options.signedInAt,
      requiresPassword: options.requiresPassword ?? false,
      passwordFailures: 0,
    });
  },
  readToken: async (hash: string) => ({
    consumedReason: state.verificationTokens.get(hash)?.consumedReason,
    passwordFailures: state.verificationTokens.get(hash)?.passwordFailures ?? 0,
  }),
  setAccountStatus: async (_userId, status) => {
    const account = state.accounts.get(USER_ID);
    if (account) account.status = status;
  },
  getTokenSignedInAt: async (hash: string) => {
    return state.verificationTokens.get(hash)?.signedInAt;
  },
  enableSecondFactor: async () => {
    state.mfaFactors.set(USER_ID, {
      factorId: 'mfa_1',
      status: 'enabled',
      email: EMAIL,
      secret: 'secret',
    });
  },
  sessionCount: async () => state.refreshTokens.size + state.webSessions.size,
  setFailSessionWrite: (value: boolean) => {
    repo.failSessionWrite = value;
  },
});
