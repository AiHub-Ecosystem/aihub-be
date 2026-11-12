import type { OnModuleInit } from '@nestjs/common';

import type {
  OutstandingQuotaReservationRegistry,
  OutstandingQuotaReservationSource,
} from '@/modules/gateway/public/outstanding-quota-reservations';
import type { SpeakingGradingJobRepositoryPort } from '@/modules/speaking/application/grading-jobs/speaking-grading-job.port';

/** Tells Gateway admission how much quota queued and unmetered Speaking jobs hold (ADR-0159). */
export class SpeakingQuotaReservationRegistration
  implements OnModuleInit, OutstandingQuotaReservationSource
{
  constructor(
    private readonly registry: Pick<
      OutstandingQuotaReservationRegistry,
      'register'
    >,
    private readonly repository: Pick<
      SpeakingGradingJobRepositoryPort,
      'countInFlight'
    >,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  outstanding(input: {
    readonly organizationId: string;
    readonly environment: 'production' | 'sandbox';
  }): Promise<number> {
    return this.repository.countInFlight(input);
  }
}
