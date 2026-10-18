import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';

import { admitMonthlyQuota } from '@/modules/gateway/application/quota-admission';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { addMeteringEvidence } from '@/modules/metering/public/metering-evidence';

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

    const admission = await admitMonthlyQuota(
      this.counter,
      {
        organizationId: authenticated.organizationId,
        quota,
        hardStopOnQuota: authenticated.hardStopOnQuota,
      },
      this.now,
    );
    if (admission === 'unverified') {
      addMeteringEvidence(request, { quotaUnverified: true });
    }

    return true;
  }
}
