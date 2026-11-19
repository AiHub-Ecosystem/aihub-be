import { invalidUserAccessToken } from '@/modules/auth/shared/application/local-auth-errors';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import { authenticationConfigurationInvalid } from '@/common/errors/auth-boundary-errors';
import { isRecord } from '@/common/is-record';
import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import {
  USER_ACCOUNT_REPOSITORY,
  type UserAccountRepositoryPort,
} from '@/modules/auth/accounts/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/local-credentials/public/local-auth';
import {
  USER_ACCESS_TOKEN_REVOCATION_RECORD,
  type UserAccessTokenRevocationRecordPort,
} from '@/modules/auth/user-access-tokens/application/user-access-token-revocation-record.port';
import {
  type DpopGuardPolicy,
  USER_ACCESS_DPOP_POLICY,
} from '@/modules/auth/web-sessions/application/user-access-token-dpop.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessSession,
  type UserAccessTokenVerifierPort,
  type VerifiedUserAccessToken,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

declare module 'fastify' {
  interface FastifyRequest {
    aihubUser?: {
      readonly userId: string;
      readonly session?: UserAccessSession;
    };
  }
}

function requiredToken(): AppError {
  return new AppError({
    code: 'AUTH_USER_ACCESS_TOKEN_REQUIRED',
    message: 'User access token is required',
    retryable: false,
  });
}

const BEARER_CHALLENGE = 'Bearer';
const DPOP_CHALLENGE = 'DPoP algs="ES256"';

function challenge(
  context: ExecutionContext,
  value: string = BEARER_CHALLENGE,
): void {
  const response = context
    .switchToHttp()
    .getResponse<FastifyReply | undefined>();
  response?.header('WWW-Authenticate', value);
}

function replayStateUnavailable(cause: unknown): AppError {
  return new AppError({
    code: 'REDIS_UNAVAILABLE',
    message: 'User access controls are temporarily unavailable',
    retryable: true,
    diagnostic: 'dpop-replay-cache-unavailable',
    cause,
  });
}

/** The request URL the proof must name: trusted-proxy scheme and host, path only. */
function proofTargetUrl(request: FastifyRequest): string {
  const path = (request.url ?? '').split(/[?#]/u, 1)[0] ?? '';
  return `${request.protocol}://${request.host}${path}`;
}

function hasAlternateTokenSource(request: FastifyRequest): boolean {
  const sources = [
    request.query,
    (request as FastifyRequest & { readonly cookies?: unknown }).cookies,
  ];
  return sources.some((source) => {
    if (!isRecord(source)) return false;
    return Object.keys(source).some((key) =>
      ['access_token', 'accesstoken', 'authorization', 'token'].includes(
        key.toLowerCase(),
      ),
    );
  });
}

@Injectable()
export class UserAccessJwtGuard implements CanActivate {
  constructor(
    @Inject(USER_ACCESS_TOKEN_VERIFIER)
    private readonly verifier: UserAccessTokenVerifierPort,
    @Inject(USER_ACCOUNT_REPOSITORY)
    private readonly userAccounts: Pick<
      UserAccountRepositoryPort,
      'findUserAccountStatus'
    >,
    @Inject(USER_ACCESS_TOKEN_REVOCATION_RECORD)
    private readonly revocations: UserAccessTokenRevocationRecordPort,
    @Inject(USER_ACCESS_DPOP_POLICY)
    private readonly dpop: DpopGuardPolicy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (hasAlternateTokenSource(request)) {
      challenge(context);
      throw invalidUserAccessToken();
    }
    if (header === undefined) {
      challenge(context);
      throw requiredToken();
    }

    if (typeof header !== 'string') {
      challenge(context);
      throw invalidUserAccessToken();
    }

    const parts = header.trim().split(/\s+/u);
    const token = parts[1];
    const scheme = parts[0]?.toLowerCase();
    const dpopScheme = scheme === 'dpop' && this.dpop.mode !== 'off';
    const failure = this.dpop.mode === 'enforce' ? DPOP_CHALLENGE : undefined;
    if (
      parts.length !== 2 ||
      (scheme !== 'bearer' && !dpopScheme) ||
      token === undefined ||
      token.split('.').length !== 3
    ) {
      challenge(context, failure);
      throw invalidUserAccessToken();
    }

    let verified: VerifiedUserAccessToken;
    try {
      verified = await this.verifier.verify(token);
    } catch {
      challenge(context, failure);
      throw invalidUserAccessToken();
    }

    // Counted before any refusal below, so Bearer use that `enforce` turns away
    // still shows up as traffic that has not migrated.
    this.dpop.recordUse?.({
      scheme: dpopScheme ? 'dpop' : 'bearer',
      session: verified.session?.kind ?? 'none',
    });

    if (dpopScheme) {
      await this.verifyProof(context, request, token, verified);
    } else if (
      this.dpop.mode === 'enforce' &&
      verified.session?.kind === 'web'
    ) {
      // A web-session token must prove possession of its key; Bearer no longer qualifies.
      challenge(context, DPOP_CHALLENGE);
      throw invalidUserAccessToken();
    }

    let status: LocalAccountStatus | undefined;
    try {
      status = await this.userAccounts.findUserAccountStatus(verified.userId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'DATABASE_UNAVAILABLE') {
        throw error;
      }
      if (isPostgresUnavailable(error)) {
        throw databaseUnavailableError(error);
      }
      throw authenticationConfigurationInvalid({ cause: error });
    }
    if (status !== 'active') {
      challenge(context);
      throw invalidUserAccessToken();
    }

    if (
      await this.revocations.isRevoked({
        issuer: verified.issuer,
        jti: verified.jti,
        now: new Date(),
      })
    ) {
      challenge(context);
      throw invalidUserAccessToken();
    }

    request.aihubUser = {
      userId: verified.userId,
      ...(verified.session === undefined ? {} : { session: verified.session }),
    };
    return true;
  }

  private async verifyProof(
    context: ExecutionContext,
    request: FastifyRequest,
    accessToken: string,
    verified: VerifiedUserAccessToken,
  ): Promise<void> {
    const proof = request.headers['dpop'];
    if (typeof proof !== 'string' || verified.jkt === undefined) {
      challenge(context, DPOP_CHALLENGE);
      throw invalidUserAccessToken();
    }
    try {
      await this.dpop.verifier.verify({
        proof,
        method: request.method,
        url: proofTargetUrl(request),
        accessToken,
        expectedJkt: verified.jkt,
        issuer: verified.issuer,
      });
    } catch (error) {
      if (error instanceof AppError) {
        challenge(context, DPOP_CHALLENGE);
        throw error;
      }
      // Replay state could not be read: refuse rather than trust an unchecked proof.
      throw replayStateUnavailable(error);
    }
  }
}
