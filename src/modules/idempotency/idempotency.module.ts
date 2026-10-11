import { Module } from '@nestjs/common';

import {
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/application/persistence-client.port';
import { PersistenceModule } from '@/modules/persistence/persistence.module';
import {
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyRepositoryPort,
} from './application/idempotency-repository.port';
import { IdempotencyService } from './application/idempotency-service';
import { IDEMPOTENCY_SERVICE } from './application/idempotency-service.port';
import { PostgresIdempotencyRepository } from './infrastructure/postgres-idempotency.repository';

@Module({
  imports: [PersistenceModule],
  providers: [
    {
      provide: IDEMPOTENCY_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): IdempotencyRepositoryPort =>
        new PostgresIdempotencyRepository({
          $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) =>
            runtime.prisma.$queryRawUnsafe<T>(query, ...values),
        }),
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
