import type {
  LoginIdentity,
  RegisterLocalAccountInput,
  UserAccountRepositoryPort,
} from '@/modules/auth/accounts/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import { AuthIdentityConflictError } from '@/modules/auth/shared/application/auth-identity-conflict.error';
import type { InMemoryAuthState } from './in-memory-auth.state';

export class InMemoryUserAccountAdapter implements UserAccountRepositoryPort {
  constructor(private readonly state: InMemoryAuthState) {}

  async register(
    input: RegisterLocalAccountInput,
  ): Promise<'queued' | 'suppressed'> {
    const accounts = [...this.state.accounts.values()];
    const sameEmail = accounts.find((account) => account.email === input.email);
    const sameUsername = accounts.find(
      (account) => account.username === input.username,
    );
    if (
      (sameEmail !== undefined &&
        sameEmail.status !== 'pending_verification') ||
      (sameUsername !== undefined && sameUsername.userId !== sameEmail?.userId)
    ) {
      throw new AuthIdentityConflictError();
    }

    const userId =
      sameEmail?.userId ?? `usr_in_memory_${this.state.accounts.size + 1}`;
    this.state.accounts.set(userId, {
      userId,
      username: input.username,
      email: input.email,
      status: 'pending_verification',
      passwordHash: input.passwordHash,
    });
    for (const token of this.state.verificationTokens.values()) {
      if (token.userId === userId && token.consumedAt === undefined) {
        token.consumedAt = input.now;
        token.consumedReason = 'superseded';
      }
    }
    this.state.verificationTokens.set(input.tokenHash, {
      tokenId: input.tokenId,
      userId,
      expiresAt: input.tokenExpiresAt,
      browserBindingHash: input.browserBindingHash,
      consumedAt: undefined,
      consumedReason: undefined,
      signedInAt: undefined,
    });
    if (input.emailDelivery !== undefined) {
      this.state.emailDeliveryRequests.push(input.emailDelivery);
    }
    return 'queued';
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
      email: account.email,
      passwordHash: account.passwordHash,
      status: account.status,
    };
  }

  async findLoginIdentityByUserId(
    userId: string,
  ): Promise<LoginIdentity | undefined> {
    const account = this.state.accounts.get(userId);
    if (account === undefined) return undefined;
    return {
      userId: account.userId,
      email: account.email,
      passwordHash: account.passwordHash,
      status: account.status,
    };
  }

  async findUserAccountStatus(
    userId: string,
  ): Promise<LocalAccountStatus | undefined> {
    return this.state.accounts.get(userId)?.status;
  }

  async findActiveUsername(userId: string): Promise<string | undefined> {
    const account = this.state.accounts.get(userId);
    return account?.status === 'active' ? account.username : undefined;
  }
}
