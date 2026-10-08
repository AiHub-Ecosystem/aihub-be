import type { FastifyRequest } from 'fastify';

import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import { createRequestContext } from '@/common/request-context/request-context.factory';
import { isRequestId } from '@/common/request-context/request-id';

const MANAGEMENT_DEADLINE_MS = 5_000;

export interface BearerRequestContext {
  readonly context: RequestContext;
  readonly requestId: string;
  readonly userId: string;
}

/**
 * Builds the request context every Bearer-authenticated management route needs
 * from the identity the guard already established. `organizationId` is passed
 * explicitly by the routes that name one, never recovered from a JWT claim.
 */
export function bearerRequestContext(
  request: FastifyRequest,
  organizationId?: string,
): BearerRequestContext {
  const userId = request.aihubUser?.userId;
  if (userId === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Authenticated user context is missing',
      retryable: false,
    });
  }

  const requestId = isRequestId(request.id) ? request.id : String(request.id);

  return {
    requestId,
    userId,
    context: createRequestContext({
      requestId,
      receivedAt: new Date(),
      deadlineMs: MANAGEMENT_DEADLINE_MS,
      ...(organizationId === undefined ? {} : { organizationId }),
      userId,
      scopes: [],
    }),
  };
}
