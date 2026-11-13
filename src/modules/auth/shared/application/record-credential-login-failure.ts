import { AppError } from '@/common/errors/app-error';
import type { AuthClock } from './auth-clock';
import type { AuthSecurityEventRecorderPort } from './auth-security-event.port';

/** Records generic credential failures with the account ID when it was resolved. */
export function recordCredentialLoginFailure(
  error: unknown,
  userAccountId: string | undefined,
  clock: AuthClock,
  securityEvents: AuthSecurityEventRecorderPort,
): void {
  if (
    !(error instanceof AppError) ||
    (error.code !== 'AUTH_CREDENTIALS_INVALID' &&
      error.code !== 'AUTH_VERIFICATION_PASSWORD_INVALID')
  ) {
    return;
  }

  securityEvents.record({
    event: 'login_failed',
    ...(userAccountId === undefined ? {} : { userAccountId }),
    occurredAt: clock.now(),
  });
}

export async function withCredentialLoginFailureRecording<T>(
  attempt: (
    rememberUserAccountId: (userAccountId: string | undefined) => void,
  ) => Promise<T>,
  clock: AuthClock,
  securityEvents: AuthSecurityEventRecorderPort,
): Promise<T> {
  let userAccountId: string | undefined;
  try {
    return await attempt((knownUserAccountId) => {
      userAccountId = knownUserAccountId;
    });
  } catch (error) {
    recordCredentialLoginFailure(error, userAccountId, clock, securityEvents);
    throw error;
  }
}
