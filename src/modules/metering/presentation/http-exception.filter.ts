import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../../common/errors/app-error';
import type { ErrorCode } from '../../../common/errors/error-code';
import {
  type ErrorEnvelope,
  createErrorEnvelope,
  createInternalErrorEnvelope,
} from '../../../common/errors/error-envelope';
import { isRequestId } from '../../../common/request-context/request-id';
import { completeRequestMetering } from '../application/metering-completion';
import { getMeteringEvidence } from '../application/metering-evidence';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
  type MeteringOutcome,
} from '../application/metering-finalizer.port';

interface FrameworkError {
  readonly code: ErrorCode;
  readonly message: string;
}

/**
 * Framework-raised statuses mapped onto the public catalogue. Messages are
 * fixed here on purpose: Nest's own text can carry the route, the failing
 * property, or a driver message, and none of that belongs in a client response.
 */
const FRAMEWORK_ERRORS: ReadonlyMap<number, FrameworkError> = new Map([
  [400, { code: 'INVALID_REQUEST', message: 'Request failed validation' }],
  [404, { code: 'NOT_FOUND', message: 'Resource not found' }],
  [405, { code: 'NOT_FOUND', message: 'Resource not found' }],
  [413, { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' }],
  [415, { code: 'INVALID_REQUEST', message: 'Unsupported content type' }],
]);

function fromHttpException(status: number): FrameworkError {
  const mapped = FRAMEWORK_ERRORS.get(status);

  if (mapped !== undefined) {
    return mapped;
  }

  // An unmapped 4xx is still the caller's problem; anything else is ours.
  return status >= 400 && status < 500
    ? { code: 'INVALID_REQUEST', message: 'Request could not be processed' }
    : { code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function isDownstreamFailure(exception: unknown): boolean {
  return (
    exception instanceof AppError &&
    (exception.downstreamStatus !== undefined ||
      exception.code.startsWith('AI_SERVICE_'))
  );
}

function meteringOutcome(exception: unknown, status: number): MeteringOutcome {
  if (isDownstreamFailure(exception)) {
    return 'downstream_error';
  }
  return status >= 500 ? 'internal_error' : 'client_error';
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(METERING_FINALIZER)
    private readonly metering: MeteringFinalizerPort,
  ) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const response = http.getResponse<FastifyReply>();
    const requestId = isRequestId(request.id) ? request.id : undefined;

    const { status, envelope } = this.resolve(
      exception,
      requestId ?? 'unknown',
    );

    // A request whose id never validated cannot be identified, so there is
    // nothing to write a record against.
    if (requestId !== undefined) {
      await completeRequestMetering(
        getMeteringEvidence(request),
        this.metering,
        {
          requestId,
          outcome: meteringOutcome(exception, status),
          httpStatus: status,
          errorCode: envelope.error.code,
          // Fastify's own response window, which starts once the reply is being
          // sent and so excludes body-parse time. The request-start metering
          // hook that used to supply a wider number is gone, and the number
          // now comes from the transport rather than from a store this filter
          // would have had to read (ADR-0061).
          totalMs: Math.max(0, Math.round(response.elapsedTime)),
        },
      );
    }

    response.status(status).send(envelope);
  }

  private resolve(
    exception: unknown,
    requestId: string,
  ): { status: number; envelope: ErrorEnvelope } {
    if (exception instanceof AppError) {
      return {
        status: exception.httpStatus,
        envelope: exception.toEnvelope(requestId),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const { code, message } = fromHttpException(status);

      return {
        status: code === 'INTERNAL_ERROR' ? 500 : status,
        envelope: createErrorEnvelope({
          code,
          message,
          requestId,
          retryable: false,
        }),
      };
    }

    return { status: 500, envelope: createInternalErrorEnvelope(requestId) };
  }
}
