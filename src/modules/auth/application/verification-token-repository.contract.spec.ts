import {
  createInMemoryAuthState,
  seedAccount as seedAccountHelper,
} from '@/modules/auth/testing/in-memory-auth.state';
import { InMemoryVerificationTokenAdapter } from '@/modules/auth/testing/in-memory-verification-token.adapter';
import { verificationTokenRepositoryContract } from '@/modules/auth/testing/verification-token.contract';

const NOW = new Date('2026-09-23T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-24T00:00:00.000Z');
const EXPIRED_AT = new Date('2026-09-22T00:00:00.000Z');
const EMAIL = 'verify@example.com';
const BINDING = 'a'.repeat(64);
const USER_ID = 'usr_1';

let state = createInMemoryAuthState();
let repo: InMemoryVerificationTokenAdapter;

verificationTokenRepositoryContract({
  userId: USER_ID,
  email: EMAIL,
  binding: BINDING,
  now: NOW,
  expiresAt: EXPIRES_AT,
  expiredAt: EXPIRED_AT,
  createRepo: () => {
    repo = new InMemoryVerificationTokenAdapter(state);
    return repo;
  },
  reset: async () => {
    state.reset();
  },
  seedAccount: async (status: string) => {
    seedAccountHelper(state, {
      userId: USER_ID,
      email: EMAIL,
      passwordHash: 'hash',
      status: status as any,
    });
  },
  insertToken: async (options: any) => {
    state.verificationTokens.set(options.hash, {
      tokenId: options.hash,
      userId: USER_ID,
      expiresAt: options.expiresAt ?? EXPIRES_AT,
      browserBindingHash: options.bindingHash,
      consumedAt: options.consumedAt,
      consumedReason: options.consumedReason,
      signedInAt: options.signedInAt,
    });
  },
  setAccountStatus: async (_userId: string, status: string) => {
    const account = state.accounts.get(USER_ID);
    if (account) (account as any).status = status;
  },
  getTokenSignedInAt: async (hash: string) => {
    return state.verificationTokens.get(hash)?.signedInAt;
  },
  setFailSessionWrite: (value: boolean) => {
    repo.failSessionWrite = value;
  },
});
