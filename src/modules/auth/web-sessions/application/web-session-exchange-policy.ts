import type { WebSessionForExchange } from './web-session-repository.port';

export type WebSessionExchangeRefusal =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'expired' | 'revoked' | 'inactive_account';
      readonly userId: string;
    };

export type WebSessionExchangeLookup =
  | {
      readonly kind: 'exchangeable';
      readonly sessionId: string;
      readonly userId: string;
    }
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'expired' | 'revoked';
      readonly userId: string;
    };

export function classifyWebSessionForExchange(
  session: WebSessionForExchange | undefined,
  now: Date,
): WebSessionExchangeLookup {
  if (session === undefined) return { kind: 'unknown' };
  if (session.revokedAt !== null) {
    return { kind: 'revoked', userId: session.userId };
  }
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'expired', userId: session.userId };
  }
  return {
    kind: 'exchangeable',
    sessionId: session.sessionId,
    userId: session.userId,
  };
}
