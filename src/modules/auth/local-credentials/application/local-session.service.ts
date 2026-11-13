import type { LoginRequest } from '@/contracts/auth/local-auth';
import type {
  AuthMfaServicePort,
  MfaSessionProof,
} from '@/modules/auth/mfa/application/auth-mfa-repository.port';
import { enforceAuthRateLimits } from '@/modules/auth/rate-limit/public/auth-rate-limit';
import type { AuthClock } from '@/modules/auth/shared/application/auth-clock';
import type { AuthSecurityEventRecorderPort } from '@/modules/auth/shared/application/auth-security-event.port';
import {
  invalidRefreshToken,
  invalidUserAccessToken,
} from '@/modules/auth/shared/application/local-auth-errors';
import { withCredentialLoginFailureRecording } from '@/modules/auth/shared/application/record-credential-login-failure';
import type { RefreshSessionRepositoryPort } from '@/modules/auth/web-sessions/application/refresh-session-repository.port';
import {
  type AuthenticatedCredentials,
  type CredentialCheckPorts,
  authenticateCredentials,
  rejectCredentials,
  upgradePasswordHashIfNeeded,
} from './local-credentials';
import {
  type LocalSessionPort,
  type LoginOutcome,
  RefreshRotationCommittedError,
} from './local-session.port';
import {
  type IssuedSession,
  type SessionTokenIssuers,
  issueSession,
} from './session-token-issuers';

const SESSION_RATE_LIMITS = {
  refresh: {
    ip: { scope: 'refresh_ip', limit: 20, windowMs: 5 * 60 * 1000 },
    token: { scope: 'refresh_token', limit: 5, windowMs: 15 * 60 * 1000 },
  },
} as const;

/**
 * Login, refresh rotation, logout, and the current-user read. Built by the auth
 * composition root, which passes every collaborator explicitly.
 */
export class LocalSessionService implements LocalSessionPort {
  constructor(
    private readonly credentials: CredentialCheckPorts,
    private readonly refreshSessions: RefreshSessionRepositoryPort,
    private readonly sessionIssuers: SessionTokenIssuers,
    private readonly clock: AuthClock,
    private readonly mfa: AuthMfaServicePort,
    private readonly securityEvents: AuthSecurityEventRecorderPort,
  ) {}

  async currentUser(userId: string): Promise<{ readonly username: string }> {
    const username =
      await this.credentials.userAccounts.findActiveUsername(userId);
    if (username === undefined) {
      throw invalidUserAccessToken();
    }
    return { username };
  }

  async login(input: LoginRequest, ip: string): Promise<LoginOutcome> {
    return withCredentialLoginFailureRecording(
      async (rememberUserAccountId) => {
        const credentials = await authenticateCredentials(
          this.credentials,
          input,
          ip,
          rememberUserAccountId,
        );
        rememberUserAccountId(credentials.userId);
        const mfa = await this.mfa.loginProof(
          credentials.userId,
          input.mfa_code,
        );
        if (mfa.kind === 'required') return { kind: 'mfa-required' };
        if (mfa.kind === 'invalid') {
          return rejectCredentials(
            this.credentials.rateLimiter,
            ip,
            credentials.email,
          );
        }
        const proof = mfa.kind === 'proved' ? mfa.proof : undefined;
        const now = this.clock.now();
        const currentCredentials = await upgradePasswordHashIfNeeded(
          this.credentials,
          credentials,
          input.password,
          now,
          ip,
        );
        const session = await this.startLoginSession(
          currentCredentials,
          now,
          ip,
          proof,
        );
        this.securityEvents.record({
          event: 'login_succeeded',
          userAccountId: credentials.userId,
          occurredAt: now,
        });
        return { kind: 'session', session };
      },
      this.clock,
      this.securityEvents,
    );
  }

  /**
   * Login mints both tokens and then persists the Refresh Session. The access
   * token is minted first, so a session write failure reaches the client
   * without an access token it could not pair with a cookie.
   */
  private async startLoginSession(
    credentials: AuthenticatedCredentials,
    now: Date,
    ip: string,
    mfaProof?: MfaSessionProof,
  ): Promise<IssuedSession> {
    const refreshToken = this.sessionIssuers.refreshTokens.issue(now);
    const session = await issueSession(
      this.sessionIssuers,
      credentials.userId,
      refreshToken,
    );
    const created = await this.refreshSessions.createRefreshSession({
      userId: credentials.userId,
      token: refreshToken,
      issuedAt: now,
      expectedPasswordHash: credentials.passwordHash,
      ...(mfaProof === undefined ? {} : { mfaProof }),
    });
    if (!created) {
      await rejectCredentials(
        this.credentials.rateLimiter,
        ip,
        credentials.email,
      );
    }
    return session;
  }

  async refresh(
    rawToken: string | undefined,
    ip: string,
  ): Promise<IssuedSession> {
    if (rawToken === undefined || rawToken.length === 0) {
      await this.enforceRefreshFailureLimits(ip);
      throw invalidRefreshToken();
    }

    const tokenHash = this.sessionIssuers.refreshTokens.hash(rawToken);
    const current =
      await this.refreshSessions.findRefreshTokenByHash(tokenHash);
    if (current === undefined) {
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    const now = this.clock.now();
    const successor = this.sessionIssuers.refreshTokens.issue(
      now,
      current.familyId,
    );
    const rotation = await this.refreshSessions.rotateRefreshToken({
      tokenId: current.tokenId,
      tokenHash,
      successor,
      now,
    });
    if (rotation.kind !== 'rotated') {
      if (rotation.reason === 'used' || rotation.reason === 'revoked') {
        this.securityEvents.record({
          event: 'refresh_reuse',
          userAccountId: current.userId,
          occurredAt: now,
        });
      }
      await this.enforceRefreshFailureLimits(ip, tokenHash);
      throw invalidRefreshToken();
    }

    try {
      return await issueSession(
        this.sessionIssuers,
        rotation.userId,
        successor,
      );
    } catch {
      throw new RefreshRotationCommittedError();
    }
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (rawToken === undefined || rawToken.length === 0) {
      return;
    }

    await this.refreshSessions.revokeRefreshFamilyByTokenHash({
      tokenHash: this.sessionIssuers.refreshTokens.hash(rawToken),
      now: this.clock.now(),
    });
  }

  private async enforceRefreshFailureLimits(
    ip: string,
    tokenHash?: string,
  ): Promise<void> {
    await enforceAuthRateLimits(this.credentials.rateLimiter, [
      {
        ...SESSION_RATE_LIMITS.refresh.ip,
        key: ip,
      },
      ...(tokenHash === undefined
        ? []
        : [
            {
              ...SESSION_RATE_LIMITS.refresh.token,
              key: tokenHash,
            },
          ]),
    ]);
  }
}
