import { Module } from '@nestjs/common';

import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import {
  IDEMPOTENCY_REPOSITORY,
  type IdempotencyRepositoryPort,
} from './application/idempotency-repository.port';
import { IdempotencyService } from './application/idempotency-service';
import { IDEMPOTENCY_SERVICE } from './application/idempotency-service.port';
import { createPostgresIdempotencyClient } from './infrastructure/postgres-idempotency.client';
import { PostgresIdempotencyRepository } from './infrastructure/postgres-idempotency.repository';

@Module({
  imports: [SecretsModule],
  providers: [
    {
      provide: IDEMPOTENCY_REPOSITORY,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): IdempotencyRepositoryPort =>
        new PostgresIdempotencyRepository(
          createPostgresIdempotencyClient(configuration.databaseUrl ?? ''),
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
