import { Module } from '@nestjs/common';

import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from './application/metering-finalizer.port';
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
import { HttpExceptionFilter } from './presentation/http-exception.filter';
import { SuccessEnvelopeInterceptor } from './presentation/success-envelope.interceptor';

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
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
  exports: [
    METERING_FINALIZER,
    USAGE_REPOSITORY,
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
})
export class MeteringModule {}
