import { AppError } from '@/common/errors/app-error';
import type { IdMinter } from '@/common/ids/prefixed-id';
import { constantTimeEquals } from '@/common/security/constant-time-equals';
import { type AuthRateLimiterPort } from './auth-rate-limiter.port';
import { type LocalAuthServiceClock } from './local-auth.service';
import { authenticateCredentials } from './local-credentials';
import { type PasswordHasherPort } from './password-hasher.port';
import { type UserAccountRepositoryPort } from './user-account.port';
import { type WebSessionClientSecretPort } from './web-session-client-secret.port';
import { type WebSessionRepositoryPort } from './web-session-repository.port';
import { type WebSessionTokenIssuerPort } from './web-session-token.port';

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

/**
 * The Web Session slice of the auth module, kept beside local login rather
 * than inside it so each Web Session route owns a file: this one creates, the
 * next three add Verification Sign-in, exchange, and logout.
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
    const token = this.tokenIssuer.issue(now);
    // Fail closed: the token reaches the BFF only after its row is committed. A
    // durable-store outage is a retryable 503 rather than a 500, so the BFF can
    // tell a temporary fault from a bad credential and keep no half state.
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
}
