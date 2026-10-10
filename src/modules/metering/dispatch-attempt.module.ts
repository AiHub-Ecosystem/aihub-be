import { Module } from '@nestjs/common';

import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import { METERING_DISPATCH_ATTEMPT_RECORDER } from './application/dispatch-attempt-recorder.port';
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
      provide: METERING_DISPATCH_ATTEMPT_RECORDER,
      useExisting: PostgresDispatchAttemptRepository,
    },
    DispatchAttemptMetricsRegistrar,
  ],
  exports: [METERING_DISPATCH_ATTEMPT_RECORDER],
})
export class DispatchAttemptModule {}
