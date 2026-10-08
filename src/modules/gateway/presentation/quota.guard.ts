import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import { AppError } from '@/common/errors/app-error';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { addMeteringEvidence } from '@/modules/metering/application/metering-evidence';

function nextMonthRetryAfterMs(now: Date): number {
  const nextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return Math.max(0, nextMonth.getTime() - now.getTime());
}

function quotaExceeded(now: Date): AppError {
  return new AppError({
    code: 'QUOTA_EXCEEDED',
    message: 'Monthly request quota exceeded',
    retryable: true,
    retryAfterMs: nextMonthRetryAfterMs(now),
  });
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(
    @Inject(QUOTA_COUNTER)
    private readonly counter: QuotaCounterPort,
    @Optional()
    private readonly now: () => Date = () => new Date(),
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

    let count: number;
    try {
      count = await this.counter.read({
        organizationId: authenticated.organizationId,
      });
      if (!validCount(count)) {
        throw new Error('quota counter value is invalid');
      }
    } catch {
      if (authenticated.hardStopOnQuota) {
        throw quotaExceeded(this.now());
      }

      addMeteringEvidence(request, { quotaUnverified: true });
      return true;
    }

    if (count >= quota) {
      throw quotaExceeded(this.now());
    }

    return true;
  }
}
