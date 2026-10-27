import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import { routeTemplate } from '@/common/http/request-tracing.hook';
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  admitGradedRequest,
  gradedAdmissionRefusal,
  retryBudgetKeyFor,
} from '@/modules/gateway/application/admit-graded-request';
import {
  GRADED_ADMISSION,
  type GradedAdmissionPort,
} from '@/modules/gateway/application/graded-admission.port';
import { RATE_WINDOW_MS } from '@/modules/gateway/application/rate-limit-window';
import type { RateLimitStanding } from '@/modules/gateway/application/rate-limiter.port';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { setGradedRequestDimensions } from '@/modules/metering/public/graded-request-timing';
import {
  addMeteringEvidence,
  getMeteringEvidence,
} from '@/modules/metering/public/metering-evidence';
import { confirmCompletedWritingReplay } from './completed-writing-replay';

/**
 * The caller's own per-key limit, in the `RateLimit-Policy` and `RateLimit`
 * fields of draft-ietf-httpapi-ratelimit-headers-11, so a client can slow
 * down before it is refused. Only the key's own figures are ever reported.
 */
function reportStanding(
  context: ExecutionContext,
  standing: RateLimitStanding | undefined,
): void {
  if (standing === undefined) return;
  const reply = context.switchToHttp().getResponse<FastifyReply>();
  reply.header(
    'RateLimit-Policy',
    `"per-key";q=${standing.limit};w=${RATE_WINDOW_MS / 1_000}`,
  );
  reply.header(
    'RateLimit',
    `"per-key";r=${standing.remaining};t=${Math.ceil(standing.resetInMs / 1_000)}`,
  );
}

/** An invalid key counts as absent here; the executor answers `INVALID_REQUEST`. */
function idempotencyKeyOf(
  request: AuthenticatedRequest,
  operation: OperationId,
): string | undefined {
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
 * Graded admission for one graded request: the API key's rate limit, then the
 * Organization retry budget, then the monthly quota, decided together by
 * `admitGradedRequest` (ADR-0057). This guard only ties that decision to the
 * request: it reads what the request carries and writes the headers, metering
 * evidence, and metrics the decision implies.
 */
@Injectable()
export class GradedAdmissionGuard implements CanActivate {
  constructor(
    @Inject(GRADED_ADMISSION)
    private readonly admission: GradedAdmissionPort,
    @Optional()
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency?: IdempotencyServicePort,
    @Optional()
    private readonly now: () => Date = () => new Date(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    const evidence = getMeteringEvidence(request);

    // A graded route always has evidence and its catalog path. Anything else is
    // a wiring fault, refused rather than admitted with weaker checks.
    if (
      evidence === undefined ||
      routeTemplate(request) !== OPERATION_CATALOG[evidence.operation].path
    ) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Graded admission is not wired for this route',
        retryable: false,
      });
    }

    const operation = evidence.operation;
    const idempotencyKey = idempotencyKeyOf(request, operation);
    setGradedRequestDimensions(request, {
      operation,
      identityMode: request.aihubIdentity?.mode ?? 'unknown',
      retryBudget:
        retryBudgetKeyFor(operation, idempotencyKey) === undefined
          ? 'none'
          : 'keyed_writing',
    });

    const decision = await admitGradedRequest(this.admission, {
      apiKeyId: authenticated.apiKeyId,
      rateLimitRpm: authenticated.rateLimitRpm,
      organizationId: authenticated.organizationId,
      requestId: String(request.id),
      operation,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      environment:
        authenticated.environment === 'sandbox' ? 'sandbox' : 'production',
      monthlyRequestQuota: authenticated.monthlyRequestQuota,
      hardStopOnQuota: authenticated.hardStopOnQuota,
    });
    reportStanding(context, decision.rate);

    if (decision.stage === 'rate_limit' || decision.stage === 'retry_budget') {
      if (decision.stage === 'rate_limit') recordRejected('rate_limit');
      throw refusalFor(decision, authenticated.organizationId, this.now);
    }

    addMeteringEvidence(request, {
      quotaTracked:
        authenticated.environment !== 'sandbox' &&
        authenticated.monthlyRequestQuota !== null,
    });

    if (decision.stage === 'quota') {
      // A confirmed completed replay costs no quota (ADR-0116).
      if (
        await confirmCompletedWritingReplay(
          request,
          authenticated,
          this.idempotency,
          operation,
          idempotencyKey,
        )
      ) {
        return true;
      }
      recordRejected('quota');
      throw refusalFor(decision, authenticated.organizationId, this.now);
    }

    if (decision.quotaUnverified) {
      addMeteringEvidence(request, { quotaUnverified: true });
    }
    return true;
  }
}

function refusalFor(
  decision: Parameters<typeof gradedAdmissionRefusal>[0],
  organizationId: string,
  now: () => Date,
): AppError {
  const refusal = gradedAdmissionRefusal(decision, organizationId, now);
  if (refusal === undefined) {
    throw new Error('an admitted request has no refusal');
  }
  return refusal;
}
