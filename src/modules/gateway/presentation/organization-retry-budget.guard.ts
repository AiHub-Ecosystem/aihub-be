import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import {
  ORGANIZATION_RETRY_BUDGET,
  type OrganizationRetryBudgetPort,
} from '@/modules/gateway/application/organization-retry-budget.port';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { getMeteringEvidence } from '@/modules/metering/public/metering-evidence';

function retryBudgetExceeded(retryAfterMs: number): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Organization retry budget exceeded',
    retryable: true,
    retryAfterMs,
    retryAfterHeader: true,
  });
}

@Injectable()
export class OrganizationRetryBudgetGuard implements CanActivate {
  constructor(
    @Inject(ORGANIZATION_RETRY_BUDGET)
    private readonly budget: OrganizationRetryBudgetPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const admission = request.aihubGradedAdmission;
    if (admission !== undefined) {
      if (admission.stage === 'retry_budget') {
        throw retryBudgetExceeded(admission.retryAfterMs);
      }
      return true;
    }

    const evidence = getMeteringEvidence(request);
    if (
      evidence === undefined ||
      OPERATION_CATALOG[evidence.operation].idempotency === 'none'
    ) {
      return true;
    }

    const rawKey = request.headers['idempotency-key'];
    if (typeof rawKey !== 'string') return true;

    let idempotencyKey: string | undefined;
    try {
      idempotencyKey = resolveIdempotencyKey(evidence.operation, rawKey);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_REQUEST') {
        return true;
      }
      throw error;
    }
    if (idempotencyKey === undefined) return true;

    const decision = await this.budget.consume({
      organizationId: getAuthenticatedApiKey(request).organizationId,
      operation: evidence.operation,
      idempotencyKey,
      requestId: String(request.id),
    });
    if (!decision.allowed) {
      throw retryBudgetExceeded(decision.retryAfterMs);
    }
    return true;
  }
}
