import type { RefreshTokenRecord } from './refresh-session-repository.port';
import { decideRefreshTokenRotation } from './refresh-token-rotation-policy';

const NOW = new Date('2026-10-26T12:00:00.000Z');
const RECORD: RefreshTokenRecord = {
  tokenId: 'rft_current',
  familyId: 'rff_family',
  userId: 'usr_owner',
  expiresAt: new Date('2026-11-01T00:00:00.000Z'),
  usedAt: undefined,
  revokedAt: undefined,
};

describe('Refresh Token rotation policy', () => {
  it('allows an active account to rotate an unused, unrevoked, unexpired token', () => {
    expect(
      decideRefreshTokenRotation({
        record: RECORD,
        accountStatus: 'active',
        now: NOW,
      }),
    ).toEqual({ kind: 'ready' });
  });

  it('rejects inactive accounts before considering stale-token family revocation', () => {
    expect(
      decideRefreshTokenRotation({
        record: { ...RECORD, usedAt: NOW },
        accountStatus: 'disabled',
        now: NOW,
      }),
    ).toEqual({ kind: 'invalid', reason: 'inactive', revokeFamily: false });
  });

  it.each([
    ['revoked', { revokedAt: NOW }],
    ['used', { usedAt: NOW }],
  ] as const)(
    'revokes the family when a %s token is presented',
    (reason, state) => {
      expect(
        decideRefreshTokenRotation({
          record: { ...RECORD, ...state },
          accountStatus: 'active',
          now: NOW,
        }),
      ).toEqual({ kind: 'invalid', reason, revokeFamily: true });
    },
  );

  it('rejects a token exactly at expiry without revoking its family', () => {
    expect(
      decideRefreshTokenRotation({
        record: { ...RECORD, expiresAt: NOW },
        accountStatus: 'active',
        now: NOW,
      }),
    ).toEqual({ kind: 'invalid', reason: 'expired', revokeFamily: false });
  });
});
