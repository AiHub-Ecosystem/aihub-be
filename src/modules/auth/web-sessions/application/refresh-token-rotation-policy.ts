import type {
  RefreshTokenFailureReason,
  RefreshTokenRecord,
} from './refresh-session-repository.port';

export type RefreshTokenRotationDecision =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'invalid';
      readonly reason: Exclude<RefreshTokenFailureReason, 'missing'>;
      readonly revokeFamily: boolean;
    };

/** Decide rotation after the account and token rows have been locked. */
export function decideRefreshTokenRotation(input: {
  readonly record: RefreshTokenRecord;
  readonly accountStatus: string;
  readonly now: Date;
}): RefreshTokenRotationDecision {
  const { record, accountStatus, now } = input;
  if (accountStatus !== 'active') {
    return { kind: 'invalid', reason: 'inactive', revokeFamily: false };
  }
  if (record.revokedAt !== undefined) {
    return { kind: 'invalid', reason: 'revoked', revokeFamily: true };
  }
  if (record.usedAt !== undefined) {
    return { kind: 'invalid', reason: 'used', revokeFamily: true };
  }
  if (record.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'invalid', reason: 'expired', revokeFamily: false };
  }
  return { kind: 'ready' };
}
