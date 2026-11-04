import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { setDispatchAttemptUnresolvedSource } from '@/common/observability/metrics';
import { PostgresDispatchAttemptRepository } from './postgres-dispatch-attempt.repository';

@Injectable()
export class DispatchAttemptMetricsRegistrar
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly repository: PostgresDispatchAttemptRepository) {}

  onModuleInit(): void {
    setDispatchAttemptUnresolvedSource(() =>
      this.repository.getUnresolvedByOperation(),
    );
  }

  onModuleDestroy(): void {
    setDispatchAttemptUnresolvedSource(undefined);
  }
}
