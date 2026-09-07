import { Module } from '@nestjs/common';

import {
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyRepositoryPort,
} from './application/idempotency-repository.port';
import { IdempotencyService } from './application/idempotency-service';
import { IDEMPOTENCY_SERVICE } from './application/idempotency-service.port';
import { IdempotencyCleanupScheduler } from './infrastructure/idempotency-cleanup.scheduler';
import { createPostgresIdempotencyClient } from './infrastructure/postgres-idempotency.client';
import { PostgresIdempotencyRepository } from './infrastructure/postgres-idempotency.repository';

@Module({
  providers: [
    IdempotencyCleanupScheduler,
    {
      provide: IDEMPOTENCY_REPOSITORY,
      useFactory: (): IdempotencyRepositoryPort =>
        new PostgresIdempotencyRepository(
          createPostgresIdempotencyClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: IDEMPOTENCY_SERVICE,
      useFactory: (repository: IdempotencyRepositoryPort): IdempotencyService =>
        new IdempotencyService(repository),
      inject: [IDEMPOTENCY_REPOSITORY],
    },
  ],
  exports: [IDEMPOTENCY_SERVICE],
})
export class IdempotencyModule {}
