import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import {
  USER_ASSERTION_VERIFIER,
  type UserAssertionVerifierPort,
} from '../application/user-assertion-verifier.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from './authenticated-request';
import { isLocalAuthBypassEnabled } from './request-environment';
import { REQUIRED_OPERATION_METADATA } from './require-operation.decorator';

function configurationError(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Authentication configuration is invalid',
    retryable: false,
  });
}

function assertionRequired(): AppError {
  return new AppError({
    code: 'USER_ASSERTION_REQUIRED',
    message: 'User assertion is required',
    retryable: false,
  });
}

function invalidAssertion(): AppError {
  return new AppError({
    code: 'INVALID_USER_ASSERTION',
    message: 'User assertion is invalid',
    retryable: false,
  });
}

@Injectable()
export class UserAssertionGuard implements CanActivate {
  constructor(
    @Inject(Reflector)
    private readonly reflector: Reflector,
    @Inject(USER_ASSERTION_VERIFIER)
    private readonly verifier: UserAssertionVerifierPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const operationId = this.reflector.getAllAndOverride<OperationId>(
      REQUIRED_OPERATION_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (operationId === undefined || !(operationId in OPERATION_CATALOG)) {
      throw configurationError();
    }

    const operation: OperationDef = OPERATION_CATALOG[operationId];
    const authenticated = getAuthenticatedApiKey(request);
    const header = request.headers['x-user-assertion'];

    if (header === undefined) {
      if (operation.identityScope === 'organization') {
        return true;
      }

      if (
        isLocalAuthBypassEnabled() &&
        authenticated.organizationId === 'local-development'
      ) {
        request.aihubIdentity = {
          userId: 'local-development',
          organizationId: authenticated.organizationId,
          scopes: [],
        };
        return true;
      }

      throw assertionRequired();
    }

    if (typeof header !== 'string' || header.trim().length === 0) {
      throw invalidAssertion();
    }

    request.aihubIdentity = await this.verifier.verify({
      signedAssertion: header,
      organizationId: authenticated.organizationId,
    });
    return true;
  }
}
