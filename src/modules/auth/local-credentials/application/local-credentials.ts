import { invalidRequest } from '@/common/errors/invalid-request';
import { type UserAccountRepositoryPort } from '@/modules/auth/accounts/application/user-account.port';
import { normalizeLogin } from '@/modules/auth/domain/local-auth';
import { invalidCredentials } from '@/modules/auth/local-credentials/application/local-auth-errors';
import {
  checkAuthRateLimits,
  enforceAuthRateLimits,
} from '@/modules/auth/rate-limit/application/auth-rate-limit';
import { type AuthRateLimiterPort } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { ARGON2ID_DUMMY_HASH } from './argon2id-parameters';
import { type PasswordHasherPort } from './password-hasher.port';

/**
 * The login dimensions, kept beside the check that consumes them so a second
 * route cannot copy the numbers and drift. `login_email` is caller-and-account
 * scoped, so a shared BFF address is never used.
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

/** The ports the credential check needs, passed so each service names its own. */
export interface CredentialCheckPorts {
  readonly userAccounts: UserAccountRepositoryPort;
  readonly passwordHasher: PasswordHasherPort;
  readonly rateLimiter: AuthRateLimiterPort;
}

export async function checkLoginLimits(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
  email: string,
): Promise<void> {
  await checkAuthRateLimits(rateLimiter, [
    { ...LOGIN_RATE_LIMITS.ip, key: ip },
    { ...LOGIN_RATE_LIMITS.email, key: JSON.stringify([ip, email]) },
  ]);
}

async function consumeLoginFailureLimits(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
  email: string,
): Promise<void> {
  await enforceAuthRateLimits(rateLimiter, [
    { ...LOGIN_RATE_LIMITS.ip, key: ip },
    { ...LOGIN_RATE_LIMITS.email, key: JSON.stringify([ip, email]) },
  ]);
}

/** The verified password snapshot must still match when a session is committed. */
export interface AuthenticatedCredentials {
  readonly userId: string;
  readonly email: string;
  readonly passwordHash: string;
}

/** Call after password and required MFA proof succeed. */
export async function upgradePasswordHashIfNeeded(
  ports: CredentialCheckPorts,
  credentials: AuthenticatedCredentials,
  password: string,
  now: Date,
  ip: string,
): Promise<AuthenticatedCredentials> {
  if (!ports.passwordHasher.needsRehash(credentials.passwordHash)) {
    return credentials;
  }

  const passwordHash = await ports.passwordHasher.hash(password);
  const updated = await ports.userAccounts.updatePasswordHash({
    userId: credentials.userId,
    expectedPasswordHash: credentials.passwordHash,
    passwordHash,
    now,
  });
  if (!updated) {
    return rejectCredentials(ports.rateLimiter, ip, credentials.email);
  }
  return { ...credentials, passwordHash };
}

export async function rejectCredentials(
  rateLimiter: AuthRateLimiterPort,
  ip: string,
  email: string,
): Promise<never> {
  await consumeLoginFailureLimits(rateLimiter, ip, email);
  throw invalidCredentials();
}

/**
 * The one credential check every route accepting an email and a password runs,
 * and the reason there is only one. A failure consumes the login limits before
 * it answers, which is what keeps a guessing caller inside them; a second
 * implementation would be the one that adds a bypass.
 *
 * Returns the authenticated account and the verified credential snapshot.
 * Throws `AUTH_CREDENTIALS_INVALID` for a
 * wrong password, an unknown email, a pending-verification account, and a
 * disabled account alike: the caller learns nothing about which it was.
 */
export async function authenticateCredentials(
  ports: CredentialCheckPorts,
  input: { readonly email: string; readonly password: string },
  ip: string,
): Promise<AuthenticatedCredentials> {
  let normalized: { readonly email: string; readonly password: string };
  try {
    normalized = normalizeLogin(input);
  } catch (error) {
    throw invalidRequest(error);
  }

  await checkLoginLimits(ports.rateLimiter, ip, normalized.email);

  const identity = await ports.userAccounts.findLoginIdentityByEmail(
    normalized.email,
  );
  const passwordHash = identity?.passwordHash ?? ARGON2ID_DUMMY_HASH;
  const passwordMatches = await ports.passwordHasher.verify(
    normalized.password,
    passwordHash,
  );

  if (
    identity === undefined ||
    !passwordMatches ||
    identity.status !== 'active'
  ) {
    return rejectCredentials(ports.rateLimiter, ip, normalized.email);
  }

  return {
    userId: identity.userId,
    email: normalized.email,
    passwordHash: identity.passwordHash,
  };
}
