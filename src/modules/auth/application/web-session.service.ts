import { AppError } from '@/common/errors/app-error';
import type { IdMinter } from '@/common/ids/prefixed-id';
import { enforceAuthRateLimit } from './auth-rate-limit';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type LocalAuthServiceClock } from './local-auth.service';
import {
  type AuthenticatedCredentials,
  authenticateCredentials,
  rejectCredentials,
} from './local-credentials';
import { type PasswordHasherPort } from './password-hasher.port';
import {
  type IssuedUserAccessToken,
  type UserAccessTokenIssuerPort,
} from './user-access-token.port';
import { type UserAccountRepositoryPort } from './user-account.port';
import {
  browserBindingHash,
  enforceWebSessionVerificationRateLimit,
} from './verification-sign-in';
import { type VerificationTokenRepositoryPort } from './verification-token-repository.port';
import { type VerificationTokenPort } from './verification-token.port';
import { webSessionUnavailable } from './web-session-errors';
import { WEB_SESSION_POLICY } from './web-session-policy';
import { type WebSessionRepositoryPort } from './web-session-repository.port';
import {
  type CreatedWebSession,
  type WebSessionServicePort,
} from './web-session-service.port';
import { type WebSessionTokenIssuerPort } from './web-session-token.port';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The exchange's own limits, modelled on the refresh pair and deliberately at
 * the same numbers: `refresh_ip` 20/5min and `refresh_token` 5/15min. An
 * attacker guessing opaque tokens is in the same position as one guessing
 * refresh tokens, and a Customer Web BFF fronts many users from few IPs, so a
 * per-IP window looser than the per-token window is the pair that fits both.
 * Only failures consume them: a BFF exchanging a session it holds consumes
 * nothing and never has its window reset by a success.
 */
const EXCHANGE_RATE_LIMITS = {
  ip: { scope: 'web_session_exchange_ip', limit: 20, windowMs: 5 * 60 * 1000 },
  token: {
    scope: 'web_session_exchange_token',
    limit: 5,
    windowMs: 15 * 60 * 1000,
  },
} as const satisfies Record<
  'ip' | 'token',
  {
    readonly scope: Parameters<AuthRateLimiterPort['consume']>[0]['scope'];
    readonly limit: number;
    readonly windowMs: number;
  }
>;

function invalidVerificationToken(): AppError {
  return new AppError({
    code: 'AUTH_VERIFICATION_TOKEN_INVALID',
    message: 'Verification token is invalid',
    retryable: false,
  });
}

/**
 * One code for every session that cannot be exchanged: expired, revoked,
 * unknown, malformed, or belonging to an account that is no longer active. The
 * caller clears the cookie and asks for a sign-in either way, so the reason is
 * recorded for diagnostics and never published.
 */
function invalidWebSession(): AppError {
  return new AppError({
    code: 'AUTH_WEB_SESSION_INVALID',
    message: 'Web session is invalid',
    retryable: false,
  });
}

/**
 * The Web Session slice of the auth module, kept beside local login rather
 * than inside it so each Web Session route owns a method here and a route in
 * one controller: creation from a password or verification token, exchange,
 * and logout all share the same durable session boundary.
 *
 * A Web Session is not a Refresh Session: its token does not rotate, belongs to
 * no token family, and its row is `web_sessions`, not `refresh_tokens`.
 */
export class WebSessionService implements WebSessionServicePort {
  constructor(
    private readonly webSessions: WebSessionRepositoryPort,
    private readonly tokenIssuer: WebSessionTokenIssuerPort,
    private readonly newSessionId: IdMinter,
    private readonly userAccounts: UserAccountRepositoryPort,
    private readonly passwordHasher: PasswordHasherPort,
    private readonly rateLimiter: AuthRateLimiterPort,
    private readonly clock: LocalAuthServiceClock,
    private readonly verificationTokenStore: VerificationTokenRepositoryPort,
    private readonly verificationTokens: VerificationTokenPort,
    private readonly accessTokenIssuer: UserAccessTokenIssuerPort,
  ) {}

  async createWebSession(
    input: { readonly email: string; readonly password: string },
    ip: string,
  ): Promise<CreatedWebSession> {
    // The same check, dummy hash, and login limits login applies, so this route
    // adds no way around them.
    const credentials = await authenticateCredentials(
      {
        userAccounts: this.userAccounts,
        passwordHasher: this.passwordHasher,
        rateLimiter: this.rateLimiter,
      },
      input,
      ip,
    );

    const now = this.clock.now();
    return this.commitSession(
      credentials,
      this.tokenIssuer.issue(now),
      now,
      ip,
    );
  }

  /**
   * The user is already known here: the verification token carries the account,
   * so there is no password to check and no credential check to bypass. What
   * decides the outcome is the Signup Browser Binding, compared inside the same
   * conditional claim the browser-facing verify route uses — which is what
   * makes "one token, at most one session, whatever its kind" true rather than
   * two paths hoping to agree.
   */
  async createWebSessionFromVerification(input: {
    readonly token: string;
    readonly browserBinding: string | undefined;
  }): Promise<CreatedWebSession | undefined> {
    // BFF requests share a proxy address. Bound repeat attempts by the token
    // hash instead, using the same verification attempt budget.
    await enforceWebSessionVerificationRateLimit(
      this.rateLimiter,
      this.verificationTokens.hash(input.token),
    );

    const now = this.clock.now();
    // Pre-issued, because the Web Session is stored in the same durable step as
    // the claim it won. A write failure rolls the claim back and the sign-in
    // stays available while the token is unexpired.
    const token = this.tokenIssuer.issue(now);
    let outcome;
    try {
      outcome = await this.verificationTokenStore.consumeVerificationToken({
        tokenHash: this.verificationTokens.hash(input.token),
        ...browserBindingHash(this.verificationTokens, input.browserBinding),
        signInSession: {
          kind: 'web-session',
          sessionId: this.newSessionId(now),
          token,
          issuedAt: now,
        },
        now,
      });
    } catch (error) {
      // Fail closed: no token reaches the BFF unless the row was committed.
      throw webSessionUnavailable(error);
    }

    if (outcome.kind === 'invalid') {
      throw invalidVerificationToken();
    }
    // The binding did not match, or another request already won the claim. The
    // email is verified either way, and the caller learns nothing more.
    if (outcome.kind === 'verified') {
      return undefined;
    }

    return { token: token.raw, expiresAt: token.expiresAt };
  }

  /**
   * The stateless exchange: read the session, mint a JWT, and slide the
   * session's expiry forward. Nothing is locked and nothing is stored for the
   * JWT, so the BFF may run as many instances as it likes and repeat a call.
   */
  async exchangeWebSession(
    input: { readonly token: string | undefined },
    ip: string,
  ): Promise<IssuedUserAccessToken> {
    if (input.token === undefined || input.token.length === 0) {
      await this.enforceExchangeFailureLimits(ip);
      throw invalidWebSession();
    }

    const tokenHash = this.tokenIssuer.hash(input.token);
    const now = this.clock.now();

    let userId: string;
    try {
      const session = await this.webSessions.findExchangeableWebSession({
        tokenHash,
        now,
      });
      // An active account is the condition of the exchange, checked beside the
      // session rather than inside it: disabling an account has to stop every
      // session it owns, not revoke them.
      if (session === undefined) {
        await this.enforceExchangeFailureLimits(ip, tokenHash);
        throw invalidWebSession();
      }
      const status = await this.userAccounts.findUserAccountStatus(
        session.userId,
      );
      if (status !== 'active') {
        await this.enforceExchangeFailureLimits(ip, tokenHash);
        throw invalidWebSession();
      }
      userId = session.userId;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      // The store owns the rows, so an outage here is a temporary fault the
      // caller must be able to tell from a bad session: `503`, and no
      // credential, so the BFF keeps its cookie.
      throw webSessionUnavailable(error);
    }

    // Sign before the final durable check, but publish nothing until it passes.
    // If revocation commits during signing or renewal, the fresh read refuses
    // this exchange. If it commits after the read, the JWT was already signed
    // before revocation, which is the documented 15-minute allowance.
    const issued = await this.accessTokenIssuer.issue(userId);
    const checkedAt = this.clock.now();
    await this.renewSession(tokenHash, checkedAt);
    let stillExchangeable;
    try {
      stillExchangeable = await this.webSessions.findExchangeableWebSession({
        tokenHash,
        now: checkedAt,
      });
    } catch (error) {
      throw webSessionUnavailable(error);
    }
    if (stillExchangeable === undefined) {
      await this.enforceExchangeFailureLimits(ip, tokenHash);
      throw invalidWebSession();
    }
    return issued;
  }

  /**
   * End exactly the presented session, quietly and idempotently.
   *
   * No rate-limit dimension, deliberately, and this is where a reader would look
   * for one: logout has no session failure to count. Every token it is offered —
   * valid, revoked, unknown, expired, malformed, or offered in a transport it
   * refuses to read — answers the same `204`, so a counter here would only ever
   * measure how often a BFF logs somebody out. Guessing opaque tokens is what
   * the exchange's own `web_session_exchange_ip` and `web_session_exchange_token`
   * dimensions are for, and logout does not widen them: presenting a token here
   * does not look one up.
   *
   * Revoking by hash needs no read: the conditional update matches no row for an
   * unknown, already-revoked, or expired session, which is the same `204` as a
   * successful one.
   */
  async revokeWebSession(input: {
    readonly token: string | undefined;
  }): Promise<void> {
    if (input.token === undefined || input.token.length === 0) {
      return;
    }

    try {
      await this.webSessions.revokeWebSession({
        tokenHash: this.tokenIssuer.hash(input.token),
        revokedAt: this.clock.now(),
      });
    } catch (error) {
      // The only failure logout may report. A BFF that cannot tell "could not
      // end it" from "already ended" would clear a cookie whose session is
      // still live, so an unreachable store is a retryable `503` and not the
      // quiet `204` every unusable session gets.
      throw webSessionUnavailable(error);
    }
  }

  /**
   * Forward-only sliding expiry, throttled to one write per hour. The repository
   * matches no row when the last renewal is too recent, when the session was
   * revoked or expired in between, or when another request won the update first;
   * the final session read distinguishes throttling from revocation. A
   * store that throws is a failure, and becomes `503` rather than a silently
   * unrenewed session the caller was told nothing about.
   */
  private async renewSession(tokenHash: string, now: Date): Promise<void> {
    try {
      await this.webSessions.renewWebSession({
        tokenHash,
        expiresAt: new Date(now.getTime() + WEB_SESSION_POLICY.ttlMs),
        renewedAt: now,
        renewedAtBefore: new Date(now.getTime() - HOUR_MS),
      });
    } catch (error) {
      throw webSessionUnavailable(error);
    }
  }

  /**
   * Fail closed: the token reaches the BFF only after its row is committed. A
   * durable-store outage is a retryable 503 rather than a 500, so the BFF can
   * tell a temporary fault from a bad credential and keep no half state.
   */
  private async commitSession(
    credentials: AuthenticatedCredentials,
    token: ReturnType<WebSessionTokenIssuerPort['issue']>,
    now: Date,
    ip: string,
  ): Promise<CreatedWebSession> {
    let created: boolean;
    try {
      created = await this.webSessions.createWebSession({
        sessionId: this.newSessionId(now),
        userId: credentials.userId,
        expectedPasswordHash: credentials.passwordHash,
        token,
        now,
      });
    } catch (error) {
      throw webSessionUnavailable(error);
    }

    if (!created) {
      await rejectCredentials(this.rateLimiter, ip, credentials.email);
    }

    return { token: token.raw, expiresAt: token.expiresAt };
  }

  /**
   * Failures only, exactly as the refresh route counts them: a working BFF
   * exchanging a session it holds never touches a counter, so a rate-limited
   * caller is one that first presented a session AIHUB could not use. The token
   * dimension is keyed by the stored hash, never by the raw credential.
   */
  private async enforceExchangeFailureLimits(
    ip: string,
    tokenHash?: string,
  ): Promise<void> {
    for (const limit of [
      { ...EXCHANGE_RATE_LIMITS.ip, key: ip },
      ...(tokenHash === undefined
        ? []
        : [{ ...EXCHANGE_RATE_LIMITS.token, key: tokenHash }]),
    ]) {
      await enforceAuthRateLimit(this.rateLimiter, limit);
    }
  }
}
