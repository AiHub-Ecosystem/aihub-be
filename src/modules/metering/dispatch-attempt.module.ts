import { Module } from '@nestjs/common';

import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import { DISPATCH_ATTEMPT_RECORD } from './application/dispatch-attempt-record.port';
import { DispatchAttemptMetricsRegistrar } from './infrastructure/dispatch-attempt-metrics.registrar';
import { PostgresDispatchAttemptRepository } from './infrastructure/postgres-dispatch-attempt.repository';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: PostgresDispatchAttemptRepository,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): PostgresDispatchAttemptRepository =>
        new PostgresDispatchAttemptRepository(runtime.prisma),
    },
    {
      provide: DISPATCH_ATTEMPT_RECORD,
      useExisting: PostgresDispatchAttemptRepository,
    },
    DispatchAttemptMetricsRegistrar,
  ],
  exports: [DISPATCH_ATTEMPT_RECORD],
})
export class DispatchAttemptModule {}
