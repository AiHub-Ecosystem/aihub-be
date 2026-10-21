import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import type {
  GradedAdmissionDecision,
  GradedAdmissionPort,
} from '@/modules/gateway/application/graded-admission.port';
import { GRADED_ADMISSION } from '@/modules/gateway/application/graded-admission.port';
import {
  RATE_LIMITER,
  type RateLimiterPort,
} from '@/modules/gateway/application/rate-limiter.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { setGradedRequestDimensions } from '@/modules/metering/public/graded-request-timing';
import { getMeteringEvidence } from '@/modules/metering/public/metering-evidence';

declare module 'fastify' {
  interface FastifyRequest {
    aihubGradedAdmission?: GradedAdmissionDecision;
  }
}

function rateLimited(retryAfterMs: number | undefined): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Rate limit exceeded',
    retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function idempotencyKeyForRequest(
  request: AuthenticatedRequest,
  operation: OperationId,
): string | undefined {
  if (
    operation !== 'writing.task1.grade' &&
    operation !== 'writing.task2.grade'
  ) {
    return undefined;
  }
  const rawKey = request.headers['idempotency-key'];
  if (typeof rawKey !== 'string') return undefined;
  try {
    return resolveIdempotencyKey(operation, rawKey);
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_REQUEST') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Lives in `gateway` rather than any one operation's module: rate limiting
 * applies to every operation, keyed on the identity `ApiKeyGuard` already
 * attached to the request, and the port it consumes (`RATE_LIMITER`) is
 * already owned here.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(RATE_LIMITER)
    private readonly limiter: RateLimiterPort,
    @Optional()
    @Inject(GRADED_ADMISSION)
    private readonly gradedAdmission?: GradedAdmissionPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    const evidence = getMeteringEvidence(request);

    if (
      evidence !== undefined &&
      routeTemplate(request) === OPERATION_CATALOG[evidence.operation].path
    ) {
      if (this.gradedAdmission === undefined) {
        throw new AppError({
          code: 'REDIS_UNAVAILABLE',
          message: 'Grading controls are temporarily unavailable',
          retryable: true,
          retryAfterMs: 1_000,
        });
      }
      const idempotencyKey = idempotencyKeyForRequest(
        request,
        evidence.operation,
      );

      setGradedRequestDimensions(request, {
        operation: evidence.operation,
        identityMode: request.aihubIdentity?.mode ?? 'unknown',
        retryBudget: idempotencyKey === undefined ? 'none' : 'keyed_writing',
      });

      const decision = await this.gradedAdmission.consume({
        apiKeyId: authenticated.apiKeyId,
        rateLimitRpm: authenticated.rateLimitRpm,
        organizationId: authenticated.organizationId,
        requestId: String(request.id),
        operation: evidence.operation,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        monthlyRequestQuota:
          authenticated.environment === 'sandbox'
            ? null
            : authenticated.monthlyRequestQuota,
      });
      request.aihubGradedAdmission = decision;

      if (decision.stage === 'rate_limit') {
        throw rateLimited(decision.retryAfterMs);
      }
      return true;
    }

    const decision = await this.limiter.consume({
      keyId: authenticated.apiKeyId,
      limit: authenticated.rateLimitRpm,
    });

    if (!decision.allowed) {
      throw rateLimited(decision.retryAfterMs);
    }

    return true;
  }
}
