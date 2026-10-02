import type { ErrorCode } from '@/common/errors/error-code';

declare module 'fastify' {
  interface FastifyRequest {
    /** The public error code the caller was sent, for the Request Completion Event. */
    aihubFailureCode?: ErrorCode;
  }
}

/**
 * The public error code one component reports for the request it is about to
 * answer.
 *
 * Two components answer a request with an error without the exception filter
 * running: the filter itself, and the oversized-body guard, which replies
 * before Nest sees the request at all. Both report here, on the request, so
 * the Request Completion Event can name the same code the caller received
 * instead of one guessed from the status afterwards.
 */
export function recordRequestFailure(
  request: { aihubFailureCode?: ErrorCode },
  errorCode: ErrorCode,
): void {
  request.aihubFailureCode = errorCode;
}
