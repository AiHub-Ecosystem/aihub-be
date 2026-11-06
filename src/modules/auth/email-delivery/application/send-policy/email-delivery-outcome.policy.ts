import type {
  EmailCredentialState,
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
} from '@/modules/auth/email-delivery/application/email-delivery-request.port';

export function isCredentialExpired(expiresAt: string, at: Date): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= at.getTime();
}

export function cancelReasonOf(
  state: Exclude<EmailCredentialState, 'actionable'>,
): EmailDeliveryCancelReason {
  return state === 'expired' ? 'credential_expired' : 'not_actionable';
}

export function errorCodeOf(error: unknown): EmailDeliveryErrorCode {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'TimeoutError'
    ? 'timeout'
    : 'provider_rejected';
}
