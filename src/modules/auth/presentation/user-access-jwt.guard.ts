import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from '../application/local-auth-repository.port';
import {
  USER_ACCESS_TOKEN_VERIFIER,
  type UserAccessTokenVerifierPort,
  type VerifiedUserAccessToken,
} from '../application/user-access-token.port';
import type { LocalAccountStatus } from '../domain/local-auth';

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

function invalidToken(): AppError {
  return new AppError({
    code: 'AUTH_USER_ACCESS_TOKEN_INVALID',
    message: 'User access token is invalid',
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
    @Inject(LOCAL_AUTH_REPOSITORY)
    private readonly repository: Pick<
      LocalAuthRepositoryPort,
      'findUserAccountStatus'
    >,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    if (hasAlternateTokenSource(request)) {
      challenge(context);
      throw invalidToken();
    }
    if (header === undefined) {
      challenge(context);
      throw requiredToken();
    }

    if (typeof header !== 'string') {
      challenge(context);
      throw invalidToken();
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
      throw invalidToken();
    }

    let verified: VerifiedUserAccessToken;
    try {
      verified = await this.verifier.verify(token);
    } catch {
      challenge(context);
      throw invalidToken();
    }

    let status: LocalAccountStatus | undefined;
    try {
      status = await this.repository.findUserAccountStatus(verified.userId);
    } catch (error) {
      throw configurationError(error);
    }
    if (status !== 'active') {
      challenge(context);
      throw invalidToken();
    }

    request.aihubUser = { userId: verified.userId };
    return true;
  }
}
