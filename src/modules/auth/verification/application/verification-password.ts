import { AppError } from '@/common/errors/app-error';
import { type PasswordHasherPort } from '@/modules/auth/local-credentials/application/password-hasher.port';
import { type VerificationTokenRepositoryPort } from './verification-token-repository.port';

/** Wrong passwords a verification token tolerates before it is spent (ADR-0123). */
export const VERIFICATION_PASSWORD_ATTEMPTS = 5;

export function verificationPasswordInvalid(): AppError {
  return new AppError({
    code: 'AUTH_VERIFICATION_PASSWORD_INVALID',
    message: 'Password does not match the registration',
    retryable: false,
  });
}

/**
 * Proves the registration password before a verification token is consumed
 * (ADR-0123), for every route that consumes one.
 *
 * It resolves to the stored hash the password was verified against, which the
 * consumption re-reads under the account lock, or to nothing when the token
 * does not need a password and none was sent. A token that is unknown, spent
 * or expired also resolves to nothing: consuming it answers that. A password
 * that is sent must match even when the token does not require one; a wrong
 * one counts against the token, and a missing one does not.
 */
export async function proveVerificationPassword(
  dependencies: {
    readonly store: Pick<
      VerificationTokenRepositoryPort,
      'readVerificationCredential' | 'recordWrongVerificationPassword'
    >;
    readonly hasher: Pick<PasswordHasherPort, 'verify'>;
  },
  input: {
    readonly tokenHash: string;
    readonly password: string | undefined;
    readonly now: Date;
  },
): Promise<{ readonly verifiedPasswordHash?: string }> {
  const credential = await dependencies.store.readVerificationCredential({
    tokenHash: input.tokenHash,
    now: input.now,
  });
  if (credential === undefined) return {};

  if (input.password === undefined) {
    if (credential.requiresPassword) throw verificationPasswordInvalid();
    return {};
  }

  if (
    !(await dependencies.hasher.verify(input.password, credential.passwordHash))
  ) {
    await dependencies.store.recordWrongVerificationPassword({
      tokenHash: input.tokenHash,
      now: input.now,
      limit: VERIFICATION_PASSWORD_ATTEMPTS,
    });
    throw verificationPasswordInvalid();
  }
  return { verifiedPasswordHash: credential.passwordHash };
}
