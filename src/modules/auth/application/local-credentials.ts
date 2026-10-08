import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { normalizeLogin } from '@/modules/auth/domain/local-auth';
import { enforceAuthRateLimit } from './auth-rate-limit';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type PasswordHasherPort } from './password-hasher.port';
import { type UserAccountRepositoryPort } from './user-account.port';

/**
 * The two login dimensions, kept beside the check that consumes them so a
 * second route cannot copy the numbers and drift. `login_ip` bounds attempts
 * from one address, `login_email` bounds attempts against one account.
 */
export const LOGIN_RATE_LIMITS = {
  ip: { scope: 'login_ip', limit: 20, windowMs: 5 * 60 * 1000 },
  email: { scope: 'login_email', limit: 5, windowMs: 15 * 60 * 1000 },
} as const satisfies Record<
  string,
  {
    readonly scope: Parameters<AuthRateLimiterPort['consume']>[0]['scope'];
    readonly limit: number;
    readonly windowMs: number;
  }
>;

/**
 * An Argon2id hash of a value nobody holds, at the same cost as a real one. An
 * unknown email is verified against this instead of skipping verification, so
 * a caller cannot tell an unregistered address from a wrong password by timing.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$SoHl8YUBzXgiAZ4xlgNZyg$qwZIFOa2OcIOgiHLRYImWLsza4k9/T4ZZvvhiWrD41k';

/** The ports the credential check needs, passed so each service names its own. */
export interface CredentialCheckPorts {
  readonly userAccounts: UserAccountRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly rateLimiter: AuthRateLimiterPort;
}

async function enforceLoginLimits(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
  email: string,
): Promise<void> {
  const limits = [
    { ...LOGIN_RATE_LIMITS.ip, key: ip },
    { ...LOGIN_RATE_LIMITS.email, key: email },
  ];
  for (const limit of limits) {
    await enforceAuthRateLimit(rateLimiter, limit);
  }
}

/**
 * The one credential check every route accepting an email and a password runs,
 * and the reason there is only one. A failure consumes the login limits before
 * it answers, which is what keeps a guessing caller inside them; a second
 * implementation would be the one that adds a bypass.
 *
 * Returns the authenticated user id. Throws `AUTH_CREDENTIALS_INVALID` for a
 * wrong password, an unknown email, a pending-verification account, and a
 * disabled account alike: the caller learns nothing about which it was.
 */
export async function authenticateCredentials(
  ports: CredentialCheckPorts,
  input: { readonly email: string; readonly password: string },
  ip: string,
): Promise<string> {
  let normalized: { readonly email: string; readonly password: string };
  try {
    normalized = normalizeLogin(input);
  } catch (error) {
    throw invalidRequest(error);
  }

  const identity = await ports.userAccounts.findLoginIdentityByEmail(
    normalized.email,
  );
  const passwordHash = identity?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await ports.passwordHasher.verify(
    normalized.password,
    passwordHash,
  );

  if (
    identity === undefined ||
    !passwordMatches ||
    identity.status !== 'active'
  ) {
    await enforceLoginLimits(ports.rateLimiter, ip, normalized.email);
    throw new AppError({
      code: 'AUTH_CREDENTIALS_INVALID',
      message: 'Email or password is invalid',
      retryable: false,
    });
  }

  return identity.userId;
}
