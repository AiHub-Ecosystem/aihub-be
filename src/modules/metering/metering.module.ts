import { randomUUID } from 'node:crypto';

import { Logger, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import {
  QUOTA_COUNTER,
  QUOTA_COUNTER_OVERWRITE,
  type QuotaCounterOverwritePort,
  type QuotaCounterPort,
} from '@/modules/gateway/application/quota-counter.port';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import {
  PUBLIC_API_MAJOR_USAGE_BUFFER,
  PUBLIC_API_MAJOR_USAGE_REPOSITORY,
  PublicApiMajorUsageBuffer,
  type PublicApiMajorUsageRepositoryPort,
} from './application/billing/public-api-major-usage';
import { PublicApiMajorUsageFlusher } from './application/billing/public-api-major-usage-flusher';
import { QuotaReconciliationService } from './application/billing/quota-reconciliation';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from './application/usage-recording/metering-finalizer.port';
import {
  METERING_FAILURE_LOGGER,
  type MeteringFailureLoggerPort,
} from './application/usage-recording/metering-logger.port';
import {
  METERING_TELEMETRY,
  type MeteringTelemetryPort,
} from './application/usage-recording/metering-telemetry.port';
import { MeteringService } from './application/usage-recording/metering.service';
import {
  USAGE_REPOSITORY,
  type UsageRepositoryPort,
} from './application/usage-recording/usage-repository.port';
import { PostgresPublicApiMajorUsageRepository } from './infrastructure/billing/postgres-public-api-major-usage.repository';
import { PostgresQuotaReconciliationRepository } from './infrastructure/billing/postgres-quota-reconciliation.repository';
import { recordPublicApiMajorUsageDrop } from './infrastructure/billing/public-api-major-usage-drop-metric';
import { PublicApiMajorUsageScheduler } from './infrastructure/billing/public-api-major-usage.scheduler';
import { QuotaReconciliationScheduler } from './infrastructure/billing/quota-reconciliation.scheduler';
import { NestMeteringFailureLogger } from './infrastructure/usage-recording/nest-metering-failure.logger';
import { PostgresUsageRepository } from './infrastructure/usage-recording/postgres-usage.repository';
import { PrometheusMeteringTelemetryAdapter } from './infrastructure/usage-recording/prometheus-metering-telemetry.adapter';
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
      provide: METERING_TELEMETRY,
      useClass: PrometheusMeteringTelemetryAdapter,
    },
    {
      provide: METERING_FINALIZER,
      useFactory: (
        repository: UsageRepositoryPort,
        logger: MeteringFailureLoggerPort,
        quotaCounter: QuotaCounterPort,
        telemetry: MeteringTelemetryPort,
      ): MeteringFinalizerPort =>
        new MeteringService(
          repository,
          logger,
          quotaCounter,
          undefined,
          telemetry,
        ),
      inject: [
        USAGE_REPOSITORY,
        METERING_FAILURE_LOGGER,
        QUOTA_COUNTER,
        METERING_TELEMETRY,
      ],
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
      provide: QuotaReconciliationService,
      inject: [RUNTIME_PRISMA_CLIENT, QUOTA_COUNTER_OVERWRITE],
      useFactory: (
        runtime: PrismaClientHolder,
        counter: QuotaCounterOverwritePort,
      ): QuotaReconciliationService => {
        return new QuotaReconciliationService(
          new PostgresQuotaReconciliationRepository(runtime.prisma),
          counter,
        );
      },
    },
    {
      provide: QuotaReconciliationScheduler,
      inject: [QuotaReconciliationService, appConfig.KEY],
      useFactory: (
        reconciliation: QuotaReconciliationService,
        configuration: ConfigType<typeof appConfig>,
      ): QuotaReconciliationScheduler =>
        new QuotaReconciliationScheduler(
          reconciliation,
          configuration.AIHUB_QUOTA_SCRUBBER_INTERVAL_MS,
          configuration.AIHUB_QUOTA_SCRUBBER_DRIFT_THRESHOLD_ABS,
          configuration.AIHUB_QUOTA_SCRUBBER_DRIFT_THRESHOLD_PERCENT / 100,
          configuration.NODE_ENV !== 'test',
        ),
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
            (event) => new Logger('PublicApiMajorUsage').warn({ event }),
          ),
          configuration.NODE_ENV !== 'test',
        ),
    },
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
  exports: [
    METERING_FINALIZER,
    METERING_TELEMETRY,
    USAGE_REPOSITORY,
    PUBLIC_API_MAJOR_USAGE_BUFFER,
    HttpExceptionFilter,
    SuccessEnvelopeInterceptor,
  ],
})
export class MeteringModule {}
