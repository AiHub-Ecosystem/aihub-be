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
    error.code !== 'AUTH_CREDENTIALS_INVALID'
  ) {
    return;
  }

  securityEvents.record({
    event: 'login_failed',
    ...(userAccountId === undefined ? {} : { userAccountId }),
    occurredAt: clock.now(),
  });
}
