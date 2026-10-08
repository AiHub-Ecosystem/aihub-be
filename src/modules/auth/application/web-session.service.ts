import { AppError } from '@/common/errors/app-error';
import type { IdMinter } from '@/common/ids/prefixed-id';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import { OPAQUE_TOKEN_BINDINGS } from '@/common/security/opaque-token-issuer';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type LocalAuthServiceClock } from './local-auth.service';
import { authenticateCredentials } from './local-credentials';
import { type PasswordHasherPort } from './password-hasher.port';
import {
  type IssuedUserAccessToken,
  type UserAccessTokenIssuerPort,
} from './user-access-token.port';
import { type UserAccountRepositoryPort } from './user-account.port';
import {
  browserBindingHash,
  enforceVerificationRateLimit,
} from './verification-sign-in';
import { type VerificationTokenRepositoryPort } from './verification-token-repository.port';
import { type VerificationTokenPort } from './verification-token.port';
import { type WebSessionClientSecretPort } from './web-session-client-secret.port';
import { type WebSessionRepositoryPort } from './web-session-repository.port';
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

export interface CreatedWebSession {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface WebSessionServicePort {
  createWebSession(
    input: { readonly email: string; readonly password: string },
    ip: string,
    presentedClientSecret: string | undefined,
  ): Promise<CreatedWebSession>;
  /**
   * Verification Sign-in. Answers the Web Session when the Signup Browser
   * Binding matched and this token's one claim was won, and `undefined` when
   * the email was verified but no session was granted — which is the same
   * bodyless `204` the browser-facing verify route answers.
   */
  createWebSessionFromVerification(
    input: {
      readonly token: string;
      readonly browserBinding: string | undefined;
    },
    ip: string,
    presentedClientSecret: string | undefined,
  ): Promise<CreatedWebSession | undefined>;
  /**
   * Trade a Web Session for a User Access JWT. `token` is `undefined` when the
   * request carried the credential somewhere this route refuses to read it
   * from, which is one generic failure like any other unusable session.
   */
  exchangeWebSession(
    input: { readonly token: string | undefined },
    ip: string,
    presentedClientSecret: string | undefined,
  ): Promise<IssuedUserAccessToken>;
}

export const WEB_SESSION_SERVICE = Symbol('WEB_SESSION_SERVICE');

/**
 * AIHUB cannot serve a Web Session right now: either the store that owns the
 * row is unreachable, or this deployment provisioned no client secret. Both are
 * `AUTH_WEB_SESSION_UNAVAILABLE`, and neither carries a credential back, so the
 * BFF keeps the cookie it already had and asks the user to try again.
 */
function storeUnavailable(cause: unknown): AppError {
  return new AppError({
    code: 'AUTH_WEB_SESSION_UNAVAILABLE',
    message: 'Web Sessions are temporarily unavailable',
    retryable: true,
    cause,
  });
}

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
 * one controller: this file creates from a password and from a verification
 * token, and the next two tickets add exchange and logout.
 *
 * A Web Session is not a Refresh Session: its token does not rotate, belongs to
 * no token family, and its row is `web_sessions`, not `refresh_tokens`.
 */
export class WebSessionService implements WebSessionServicePort {
  constructor(
    private readonly webSessions: WebSessionRepositoryPort,
    private readonly tokenIssuer: WebSessionTokenIssuerPort,
    private readonly newSessionId: IdMinter,
    private readonly clientSecret: WebSessionClientSecretPort,
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
    presentedClientSecret: string | undefined,
  ): Promise<CreatedWebSession> {
    // The caller proves who it is before AIHUB looks at a credential or a
    // session, so a request without the secret never reaches the store.
    this.assertClientSecret(presentedClientSecret);

    // The same check, dummy hash, and login limits login applies, so this route
    // adds no way around them.
    const userId = await authenticateCredentials(
      {
        userAccounts: this.userAccounts,
        passwordHasher: this.passwordHasher,
        rateLimiter: this.rateLimiter,
      },
      input,
      ip,
    );

    const now = this.clock.now();
    return this.commitSession(userId, this.tokenIssuer.issue(now), now);
  }

  /**
   * The user is already known here: the verification token carries the account,
   * so there is no password to check and no credential check to bypass. What
   * decides the outcome is the Signup Browser Binding, compared inside the same
   * conditional claim the browser-facing verify route uses — which is what
   * makes "one token, at most one session, whatever its kind" true rather than
   * two paths hoping to agree.
   */
  async createWebSessionFromVerification(
    input: {
      readonly token: string;
      readonly browserBinding: string | undefined;
    },
    ip: string,
    presentedClientSecret: string | undefined,
  ): Promise<CreatedWebSession | undefined> {
    this.assertClientSecret(presentedClientSecret);

    // The limit verify-email already applies, so this route adds no dimension
    // and no bypass.
    await enforceVerificationRateLimit(this.rateLimiter, ip);

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
      throw storeUnavailable(error);
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
    presentedClientSecret: string | undefined,
  ): Promise<IssuedUserAccessToken> {
    this.assertClientSecret(presentedClientSecret);

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
      throw storeUnavailable(error);
    }

    // Fail closed: the renewal is a durable write this exchange depends on, so
    // it runs before the JWT is signed. A store that cannot record the renewal
    // is a temporary fault the BFF must be able to tell from a bad session, and
    // it answers `503` with no credential rather than handing out a JWT whose
    // exchange was never durably recorded. A throttled write, a write another
    // instance won, or a session revoked in between is still a normal outcome:
    // the conditional update matches no row and the exchange proceeds.
    await this.renewSession(tokenHash, now);

    return this.accessTokenIssuer.issue(userId);
  }

  /**
   * Forward-only sliding expiry, throttled to one write per hour. The repository
   * matches no row when the last renewal is too recent, when the session was
   * revoked or expired in between, or when another request won the update first;
   * none of those is an exchange failure, and none of them fails this method. A
   * store that throws is a failure, and becomes `503` rather than a silently
   * unrenewed session the caller was told nothing about.
   */
  private async renewSession(tokenHash: string, now: Date): Promise<void> {
    try {
      await this.webSessions.renewWebSession({
        tokenHash,
        expiresAt: new Date(
          now.getTime() + OPAQUE_TOKEN_BINDINGS.webSession.ttlMs,
        ),
        renewedAt: now,
        renewedAtBefore: new Date(now.getTime() - HOUR_MS),
      });
    } catch (error) {
      throw storeUnavailable(error);
    }
  }

  /**
   * Fail closed: the token reaches the BFF only after its row is committed. A
   * durable-store outage is a retryable 503 rather than a 500, so the BFF can
   * tell a temporary fault from a bad credential and keep no half state.
   */
  private async commitSession(
    userId: string,
    token: ReturnType<WebSessionTokenIssuerPort['issue']>,
    now: Date,
  ): Promise<CreatedWebSession> {
    try {
      await this.webSessions.createWebSession({
        sessionId: this.newSessionId(now),
        userId,
        token,
        now,
      });
    } catch (error) {
      throw storeUnavailable(error);
    }

    return { token: token.raw, expiresAt: token.expiresAt };
  }

  /**
   * A missing or wrong secret is one generic `401` that says nothing about
   * which it was, and the comparison is constant time so it says nothing about
   * how much of the value matched. A deployment that provisioned no secret
   * answers `503`: refusing is the only safe answer, never treating every
   * caller as approved.
   */
  private assertClientSecret(presented: string | undefined): void {
    const expected = this.clientSecret.resolve();
    if (expected === undefined) {
      throw storeUnavailable(
        new Error('no Customer Web BFF client secret is provisioned'),
      );
    }
    if (presented === undefined || !constantTimeEquals(presented, expected)) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        message: 'Client secret is missing or invalid',
        retryable: false,
      });
    }
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
      const result = await this.rateLimiter.consume(limit);
      if (!result.allowed) {
        throw new AppError({
          code: 'RATE_LIMITED',
          message: 'Too many requests',
          retryable: true,
          ...(result.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: result.retryAfterMs }),
        });
      }
    }
  }
}
