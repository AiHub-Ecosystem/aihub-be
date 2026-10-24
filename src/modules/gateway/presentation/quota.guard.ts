import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import { admitMonthlyQuota } from '@/modules/gateway/application/quota-admission';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import { quotaExceededError } from '@/modules/gateway/application/quota-period';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import {
  addMeteringEvidence,
  getMeteringEvidence,
} from '@/modules/metering/public/metering-evidence';
import { setCompletedReplay } from './completed-idempotency-replay';

async function isCompletedWritingReplay(
  request: AuthenticatedRequest,
  authenticated: ReturnType<typeof getAuthenticatedApiKey>,
  idempotency: IdempotencyServicePort | undefined,
): Promise<boolean> {
  const operation = getMeteringEvidence(request)?.operation;
  const actorId = request.aihubIdentity?.userId;
  const header = request.headers['idempotency-key'];
  if (
    idempotency?.findCompletedReplay === undefined ||
    actorId === undefined ||
    typeof header !== 'string' ||
    (operation !== 'writing.task1.grade' && operation !== 'writing.task2.grade')
  ) {
    return false;
  }

  let idempotencyKey: string | undefined;
  let requestBody: unknown;
  try {
    idempotencyKey = resolveIdempotencyKey(operation, header);
    if (idempotencyKey === undefined) return false;
    requestBody =
      operation === 'writing.task1.grade'
        ? parseRequestBody(GradeTask1RequestSchema, request.body, request)
        : parseRequestBody(GradeTask2RequestSchema, request.body, request);
  } catch (error) {
    if (error instanceof AppError && error.code === 'INVALID_REQUEST') {
      return false;
    }
    return false;
  }

  try {
    const replay = await idempotency.findCompletedReplay({
      organizationId: authenticated.organizationId,
      operation,
      actorId,
      idempotencyKey,
      requestBody,
    });
    if (replay === undefined) return false;
    setCompletedReplay(request, { operation, idempotencyKey, replay });
    return true;
  } catch {
    // At exhausted quota, a replay bypass requires a confirmed durable match.
    return false;
  }
}

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    @Inject(QUOTA_COUNTER)
    private readonly counter: QuotaCounterPort,
    @Optional()
    private readonly now: () => Date = () => new Date(),
    @Optional()
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency?: IdempotencyServicePort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authenticated = getAuthenticatedApiKey(request);
    if (authenticated.environment === 'sandbox') {
      addMeteringEvidence(request, { quotaTracked: false });
      return true;
    }

    const quota = authenticated.monthlyRequestQuota;

    addMeteringEvidence(request, { quotaTracked: quota !== null });
    if (quota === null) {
      return true;
    }

    const gradedAdmission = request.aihubGradedAdmission;
    if (gradedAdmission !== undefined) {
      if (
        gradedAdmission.stage === 'quota' &&
        !(await isCompletedWritingReplay(
          request,
          authenticated,
          this.idempotency,
        ))
      ) {
        recordRejected('quota');
        throw quotaExceededError(this.now(), authenticated.organizationId);
      }
      if (
        gradedAdmission.stage === 'admitted' &&
        gradedAdmission.quotaUnverified
      ) {
        addMeteringEvidence(request, { quotaUnverified: true });
      }
      return true;
    }

    let admission: Awaited<ReturnType<typeof admitMonthlyQuota>>;
    try {
      admission = await admitMonthlyQuota(
        this.counter,
        {
          organizationId: authenticated.organizationId,
          quota,
          hardStopOnQuota: authenticated.hardStopOnQuota,
        },
        this.now,
      );
    } catch (error) {
      // A confirmed completed replay costs no quota, so it passes whether the
      // quota is exhausted or could not be verified.
      if (
        error instanceof AppError &&
        (error.code === 'QUOTA_EXCEEDED' ||
          error.code === 'REDIS_UNAVAILABLE') &&
        (await isCompletedWritingReplay(
          request,
          authenticated,
          this.idempotency,
        ))
      ) {
        return true;
      }
      if (error instanceof AppError && error.code === 'QUOTA_EXCEEDED') {
        recordRejected('quota');
      }
      throw error;
    }
    if (admission === 'unverified') {
      addMeteringEvidence(request, { quotaUnverified: true });
    }

    return true;
  }
}
