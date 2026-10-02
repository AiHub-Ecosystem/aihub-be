import type { UserAccountRepositoryPort } from '@/modules/auth/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';

/**
 * The User Account slice Bearer authorization reads, for a test outside local
 * auth that needs no account lifecycle. The resolver may be asynchronous, or
 * read the real status a database-backed lane just wrote.
 *
 * Tests that exercise registration or sign-in compose
 * `InMemoryUserAccountAdapter` over `InMemoryAuthState` instead.
 */
export function userAccountStatus(
  statusFor: (
    userId: string,
  ) =>
    | LocalAccountStatus
    | undefined
    | Promise<LocalAccountStatus | undefined> = () => 'active',
): Pick<UserAccountRepositoryPort, 'findUserAccountStatus'> {
  return {
    findUserAccountStatus: async (userId: string) => statusFor(userId),
  };
}
