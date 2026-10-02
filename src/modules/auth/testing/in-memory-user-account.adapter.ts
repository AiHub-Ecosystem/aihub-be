import { AuthIdentityConflictError } from '@/modules/auth/application/auth-identity-conflict.error';
import type {
  LoginIdentity,
  RegisterLocalAccountInput,
  UserAccountRepositoryPort,
} from '@/modules/auth/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import type { InMemoryAuthState } from './in-memory-auth.state';

export class InMemoryUserAccountAdapter implements UserAccountRepositoryPort {
  constructor(private readonly state: InMemoryAuthState) {}

  async register(input: RegisterLocalAccountInput): Promise<void> {
    const taken = [...this.state.accounts.values()].some(
      (account) =>
        account.email === input.email || account.username === input.username,
    );
    if (taken) {
      throw new AuthIdentityConflictError();
    }

    const userId = `usr_in_memory_${this.state.accounts.size + 1}`;
    this.state.accounts.set(userId, {
      userId,
      username: input.username,
      email: input.email,
      status: 'pending_verification',
      passwordHash: input.passwordHash,
    });
    this.state.verificationTokens.set(input.tokenHash, {
      tokenId: input.tokenId,
      userId,
      expiresAt: input.tokenExpiresAt,
      browserBindingHash: input.browserBindingHash,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
  }

  async findLoginIdentityByEmail(
    email: string,
  ): Promise<LoginIdentity | undefined> {
    const account = [...this.state.accounts.values()].find(
      (candidate) => candidate.email === email,
    );
    if (account === undefined) {
      return undefined;
    }
    return {
      userId: account.userId,
      passwordHash: account.passwordHash,
      status: account.status,
    };
  }

  async findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined> {
    return this.state.accounts.get(userId)?.status;
  }
}
