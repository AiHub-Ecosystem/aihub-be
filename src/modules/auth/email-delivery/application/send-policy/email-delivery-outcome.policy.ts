import { isRecord } from '@/common/is-record';
import type { EmailCredentialState } from '@/modules/auth/email-delivery/application/email-credential-actionability.port';
import type {
  EmailDeliveryCancelReason,
  EmailDeliveryErrorCode,
} from '@/modules/auth/email-delivery/application/email-delivery-request.types';

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
  return isRecord(error) && 'name' in error && error['name'] === 'TimeoutError'
    ? 'timeout'
    : 'provider_rejected';
}
