import { randomUUID } from 'node:crypto';

import { Logger, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
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
  PUBLIC_API_MAJOR_USAGE_BUFFER,
  PUBLIC_API_MAJOR_USAGE_REPOSITORY,
  PublicApiMajorUsageBuffer,
  type PublicApiMajorUsageRepositoryPort,
} from './application/public-api-major-usage';
import { PublicApiMajorUsageFlusher } from './application/public-api-major-usage-flusher';
import {
  USAGE_REPOSITORY,
  type UsageRepositoryPort,
} from './application/usage-repository.port';
import { NestMeteringFailureLogger } from './infrastructure/nest-metering-failure.logger';
import { PostgresPublicApiMajorUsageRepository } from './infrastructure/postgres-public-api-major-usage.repository';
import { PostgresUsageRepository } from './infrastructure/postgres-usage.repository';
import { recordPublicApiMajorUsageDrop } from './infrastructure/public-api-major-usage-drop-metric';
import { PublicApiMajorUsageScheduler } from './infrastructure/public-api-major-usage.scheduler';
import { HttpExceptionFilter } from './presentation/http-exception.filter';
import { SuccessEnvelopeInterceptor } from './presentation/success-envelope.interceptor';

@Module({
  imports: [RuntimeConfigurationModule, PersistenceModule, GatewayModule],
  providers: [
    {
      provide: USAGE_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): UsageRepositoryPort =>
        new PostgresUsageRepository(runtime.prisma),
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
    {
      provide: PUBLIC_API_MAJOR_USAGE_BUFFER,
      useFactory: (): PublicApiMajorUsageBuffer =>
        new PublicApiMajorUsageBuffer(recordPublicApiMajorUsageDrop),
    },
    {
      provide: PUBLIC_API_MAJOR_USAGE_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): PublicApiMajorUsageRepositoryPort =>
        new PostgresPublicApiMajorUsageRepository(runtime.prisma),
    },
    {
      provide: PublicApiMajorUsageScheduler,
      inject: [
        PUBLIC_API_MAJOR_USAGE_BUFFER,
        PUBLIC_API_MAJOR_USAGE_REPOSITORY,
        appConfig.KEY,
      ],
      useFactory: (
        buffer: PublicApiMajorUsageBuffer,
        repository: PublicApiMajorUsageRepositoryPort,
        configuration: ConfigType<typeof appConfig>,
      ): PublicApiMajorUsageScheduler =>
        new PublicApiMajorUsageScheduler(
          new PublicApiMajorUsageFlusher(
            buffer,
            repository,
            configuration.AIHUB_RUNTIME_DATABASE_SCOPE,
            // Built before the HTTP server listens, so the process's coverage
            // starts no later than the first request it serves.
            { processId: randomUUID(), startedAt: new Date() },
            (message) => new Logger('PublicApiMajorUsage').warn(message),
          ),
          configuration.NODE_ENV !== 'test',
        ),
    },
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
  exports: [
    METERING_FINALIZER,
    USAGE_REPOSITORY,
    PUBLIC_API_MAJOR_USAGE_BUFFER,
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
})
export class MeteringModule {}
