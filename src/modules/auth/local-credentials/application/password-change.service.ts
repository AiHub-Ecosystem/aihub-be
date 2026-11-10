import { invalidRequest } from '@/common/errors/invalid-request';
import type { UserAccountRepositoryPort } from '@/modules/auth/accounts/application/user-account.port';
import { validatePassword } from '@/modules/auth/local-credentials/public/local-auth';
import type { AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import type { AuthClock } from '@/modules/auth/shared/application/auth-clock';
import {
  invalidCredentials,
  invalidUserAccessToken,
} from '@/modules/auth/shared/application/local-auth-errors';
import type { UserAccessSession } from '@/modules/auth/web-sessions/application/user-access-token.port';
import { checkLoginLimits, rejectCredentials } from './local-credentials';
import type { PasswordChangeRepositoryPort } from './password-change-repository.port';
import type { PasswordChangePort } from './password-change.port';
import type { PasswordHasherPort } from './password-hasher.port';

export class PasswordChangeService implements PasswordChangePort {
  constructor(
    private readonly accounts: Pick<
      UserAccountRepositoryPort,
      'findLoginIdentityByUserId'
    >,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly repository: PasswordChangeRepositoryPort,
    private readonly clock: AuthClock,
  ) {}

  async change(input: {
    readonly userId: string;
    readonly session: UserAccessSession | undefined;
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly ip: string;
  }): Promise<void> {
    if (input.session === undefined) {
      throw invalidUserAccessToken();
    }

    try {
      validatePassword(input.newPassword);
    } catch (error) {
      throw invalidRequest(error);
    }

    const identity = await this.accounts.findLoginIdentityByUserId(
      input.userId,
    );
    if (identity === undefined || identity.status !== 'active') {
      throw invalidCredentials();
    }

    await checkLoginLimits(this.rateLimiter, input.ip, identity.email);
    if (
      !(await this.passwordHasher.verify(
        input.currentPassword,
        identity.passwordHash,
      ))
    ) {
      return rejectCredentials(this.rateLimiter, input.ip, identity.email);
    }

    const now = this.clock.now();
    const passwordHash = await this.passwordHasher.hash(input.newPassword);
    const changed = await this.repository.changePassword({
      userId: input.userId,
      expectedPasswordHash: identity.passwordHash,
      passwordHash,
      session: input.session,
      now,
      emailDelivery: {
        kind: 'password_changed_notification',
        payload: { email: identity.email },
        createdAt: now,
      },
    });
    if (!changed) {
      return rejectCredentials(this.rateLimiter, input.ip, identity.email);
    }
  }
}
