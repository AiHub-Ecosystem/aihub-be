import { Module } from '@nestjs/common';

import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import { DISPATCH_ATTEMPT_RECORD } from './application/dispatch-attempt-record.port';
import { DispatchAttemptMetricsRegistrar } from './infrastructure/dispatch-attempt-metrics.registrar';
import {
  PostgresDispatchAttemptRepository,
  createPostgresDispatchAttemptRepository,
} from './infrastructure/postgres-dispatch-attempt.repository';

@Module({
  imports: [SecretsModule],
  providers: [
    {
      provide: PostgresDispatchAttemptRepository,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): PostgresDispatchAttemptRepository =>
        createPostgresDispatchAttemptRepository(
          configuration.databaseUrl ?? '',
        ),
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
