import { invalidUserAccessToken } from '@/modules/auth/local-credentials/application/local-auth-errors';
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import {
  USER_ACCOUNT_REPOSITORY,
  type UserAccountRepositoryPort,
} from '@/modules/auth/accounts/application/user-account.port';
import type { LocalAccountStatus } from '@/modules/auth/domain/local-auth';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
  type VerifiedUserAccessToken,
} from '@/modules/auth/web-sessions/application/user-access-token.port';

declare module 'fastify' {
  interface FastifyRequest {
    aihubUser?: { readonly userId: string };
  }
}

function requiredToken(): AppError {
  return new AppError({
    code: 'AUTH_USER_ACCESS_TOKEN_REQUIRED',
    message: 'User access token is required',
    retryable: false,
  });
}

function configurationError(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
    cause,
  });
}

function challenge(context: ExecutionContext): void {
  const response = context
    .switchToHttp()
    .getResponse<FastifyReply | undefined>();
  response?.header('WWW-Authenticate', 'Bearer');
}

function hasAlternateTokenSource(request: FastifyRequest): boolean {
  const sources = [
    request.query,
    (request as FastifyRequest & { readonly cookies?: unknown }).cookies,
  ];
  return sources.some((source) => {
    if (
      typeof source !== 'object' ||
      source === null ||
      Array.isArray(source)
    ) {
      return false;
    }
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
    if (
      parts.length !== 2 ||
      parts[0]?.toLowerCase() !== 'bearer' ||
      token === undefined ||
      token.split('.').length !== 3
    ) {
      challenge(context);
      throw invalidUserAccessToken();
    }

    let verified: VerifiedUserAccessToken;
    try {
      verified = await this.verifier.verify(token);
    } catch {
      challenge(context);
      throw invalidUserAccessToken();
    }

    let status: LocalAccountStatus | undefined;
    try {
      status = await this.userAccounts.findUserAccountStatus(verified.userId);
    } catch (error) {
      throw configurationError(error);
    }
    if (status !== 'active') {
      challenge(context);
      throw invalidUserAccessToken();
    }

    request.aihubUser = { userId: verified.userId };
    return true;
  }
}
