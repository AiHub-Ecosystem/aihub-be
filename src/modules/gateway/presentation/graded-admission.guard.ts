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
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  type AdmitGradedRequestInput,
  admitGradedRequest,
  gradedAdmissionPolicy,
  gradedAdmissionRefusal,
} from '@/modules/gateway/application/admit-graded-request';
import {
  GRADED_ADMISSION,
  type GradedAdmissionPort,
} from '@/modules/gateway/application/graded-admission.port';
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
import { setCompletedReplay } from './completed-idempotency-replay';
import { findCompletedWritingReplay } from './completed-writing-replay';
import { reportStanding } from './rate-limit-standing';

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
    const input: AdmitGradedRequestInput = {
      apiKeyId: authenticated.apiKeyId,
      rateLimitRpm: authenticated.rateLimitRpm,
      organizationId: authenticated.organizationId,
      requestId: request.id,
      operation,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      environment:
        authenticated.environment === 'sandbox' ? 'sandbox' : 'production',
      monthlyRequestQuota: authenticated.monthlyRequestQuota,
      hardStopOnQuota: authenticated.hardStopOnQuota,
    };
    const policy = gradedAdmissionPolicy(input);
    setGradedRequestDimensions(request, {
      operation,
      identityMode: request.aihubIdentity?.mode ?? 'unknown',
      retryBudget: policy.retryBudget,
    });

    const decision = await admitGradedRequest(this.admission, input);
    reportStanding(context, decision.rate);

    if (decision.stage === 'rate_limit') {
      recordRejected('rate_limit');
      throw gradedAdmissionRefusal(
        decision,
        authenticated.organizationId,
        this.now,
      );
    }
    if (decision.stage === 'retry_budget') {
      throw gradedAdmissionRefusal(
        decision,
        authenticated.organizationId,
        this.now,
      );
    }

    addMeteringEvidence(request, { quotaTracked: policy.quotaTracked });

    if (decision.stage === 'quota') {
      // A confirmed completed replay costs no quota (ADR-0116).
      const replay = await findCompletedWritingReplay(
        request,
        this.idempotency,
        {
          organizationId: authenticated.organizationId,
          operation,
          idempotencyKey,
        },
      );
      if (replay !== undefined) {
        setCompletedReplay(request, replay);
        return true;
      }
      recordRejected('quota');
      throw gradedAdmissionRefusal(
        decision,
        authenticated.organizationId,
        this.now,
      );
    }

    if (decision.quotaUnverified) {
      addMeteringEvidence(request, { quotaUnverified: true });
    }
    return true;
  }
}
