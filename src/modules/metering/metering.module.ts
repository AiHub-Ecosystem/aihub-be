import { Module } from '@nestjs/common';

import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '../../common/request-metering/metering-finalizer.port';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '../gateway/application/quota-counter.port';
import { GatewayModule } from '../gateway/gateway.module';
import {
  METERING_FAILURE_LOGGER,
  type MeteringFailureLoggerPort,
} from './application/metering-logger.port';
import { MeteringService } from './application/metering.service';
import {
  USAGE_REPOSITORY,
  type UsageRepositoryPort,
} from './application/usage-repository.port';
import { NestMeteringFailureLogger } from './infrastructure/nest-metering-failure.logger';
import {
  PostgresUsageRepository,
  createPostgresMeteringClient,
} from './infrastructure/postgres-usage.repository';

@Module({
  imports: [GatewayModule],
  providers: [
    {
      provide: USAGE_REPOSITORY,
      useFactory: (): UsageRepositoryPort =>
        new PostgresUsageRepository(
          createPostgresMeteringClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: METERING_FAILURE_LOGGER,
      useClass: NestMeteringFailureLogger,
    },
    {
      provide: METERING_FINALIZER,
      useFactory: (
        repository: UsageRepositoryPort,
        logger: MeteringFailureLoggerPort,
        quotaCounter: QuotaCounterPort,
      ): MeteringFinalizerPort =>
        new MeteringService(repository, logger, quotaCounter),
      inject: [USAGE_REPOSITORY, METERING_FAILURE_LOGGER, QUOTA_COUNTER],
    },
  ],
  exports: [METERING_FINALIZER, USAGE_REPOSITORY],
})
export class MeteringModule {}
