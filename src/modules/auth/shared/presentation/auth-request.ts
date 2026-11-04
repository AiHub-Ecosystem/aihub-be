import { AppError, internalError } from '@/common/errors/app-error';
import type { FastifyRequest } from 'fastify';

import { webSessionUnavailable } from '@/modules/auth/web-sessions/public';

import { endUserIpFrom } from './web-session-transport';

export function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.aihubUser?.userId;
  if (userId === undefined) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Authenticated user context is missing',
      retryable: false,
    });
  }
  return userId;
}

/** The Customer Web BFF supplies the end user's address in its own header. */
export function credentialIp(request: FastifyRequest): string {
  if (request.aihubClientIpSource !== 'customer_web_bff') {
    return requestIp(request);
  }
  const ip = endUserIpFrom(request);
  if (ip === undefined) {
    throw webSessionUnavailable(
      internalError(
        'Customer Web BFF omitted or malformed X-AIHUB-End-User-IP',
      ),
    );
  }
  return ip;
}
