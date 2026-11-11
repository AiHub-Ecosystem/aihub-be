import { classifyWebSessionForExchange } from './web-session-exchange-policy';

const NOW = new Date('2026-10-08T00:00:00.000Z');
const SESSION = {
  sessionId: 'wss_01J00000000000000000000000',
  userId: 'usr_01J00000000000000000000000',
  expiresAt: new Date(NOW.getTime() + 1),
  revokedAt: null,
};

describe('classifyWebSessionForExchange', () => {
  it('classifies an absent session as unknown', () => {
    expect(classifyWebSessionForExchange(undefined, NOW)).toEqual({
      kind: 'unknown',
    });
  });

  it('gives revocation precedence over expiry', () => {
    expect(
      classifyWebSessionForExchange(
        {
          ...SESSION,
          expiresAt: NOW,
          revokedAt: new Date(NOW.getTime() - 1),
        },
        NOW,
      ),
    ).toEqual({ kind: 'revoked', userId: SESSION.userId });
  });

  it('treats the expiry instant as expired', () => {
    expect(
      classifyWebSessionForExchange({ ...SESSION, expiresAt: NOW }, NOW),
    ).toEqual({ kind: 'expired', userId: SESSION.userId });
  });

  it('returns the session identity before expiry', () => {
    expect(classifyWebSessionForExchange(SESSION, NOW)).toEqual({
      kind: 'exchangeable',
      sessionId: SESSION.sessionId,
      userId: SESSION.userId,
    });
  });
});
