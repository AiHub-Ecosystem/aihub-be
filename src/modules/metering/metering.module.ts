import { randomUUID } from 'node:crypto';

import { Logger, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import {
  MONTHLY_BILLABLE_USAGE,
  type MonthlyBillableUsagePort,
} from './application/billing/monthly-billable-usage.port';
import {
  PUBLIC_API_MAJOR_USAGE_BUFFER,
  PUBLIC_API_MAJOR_USAGE_REPOSITORY,
  PublicApiMajorUsageBuffer,
  type PublicApiMajorUsageRepositoryPort,
} from './application/billing/public-api-major-usage';
import { PublicApiMajorUsageFlusher } from './application/billing/public-api-major-usage-flusher';
import { QuotaReconciliationService } from './application/billing/quota-reconciliation';
import {
  QUOTA_COUNTER,
  QUOTA_COUNTER_OVERWRITE,
  QUOTA_COUNTER_SEED,
  type QuotaCounterOverwritePort,
  type QuotaCounterPort,
} from './application/quota/quota-counter.port';
import { DISPATCH_ATTEMPT_RECORD } from './application/usage-recording/dispatch-attempt-record.port';
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
import { PostgresMonthlyBillableUsage } from './infrastructure/billing/postgres-monthly-billable-usage';
import { PostgresPublicApiMajorUsageRepository } from './infrastructure/billing/postgres-public-api-major-usage.repository';
import { PostgresQuotaReconciliationRepository } from './infrastructure/billing/postgres-quota-reconciliation.repository';
import { recordPublicApiMajorUsageDrop } from './infrastructure/billing/public-api-major-usage-drop-metric';
import { PublicApiMajorUsageScheduler } from './infrastructure/billing/public-api-major-usage.scheduler';
import { QuotaReconciliationScheduler } from './infrastructure/billing/quota-reconciliation.scheduler';
import {
  REDIS_METERING_CLIENT,
  type RedisMeteringClient,
  createRedisMeteringClient,
} from './infrastructure/quota/redis-metering.client';
import { RedisQuotaCounter } from './infrastructure/quota/redis-quota-counter';
import { RedisQuotaReconciliationCounter } from './infrastructure/quota/redis-quota-reconciliation.counter';
import { RedisQuotaSeeder } from './infrastructure/quota/redis-quota-seed';
import { DispatchAttemptMetricsRegistrar } from './infrastructure/usage-recording/dispatch-attempt-metrics.registrar';
import { NestMeteringFailureLogger } from './infrastructure/usage-recording/nest-metering-failure.logger';
import { PostgresDispatchAttemptRepository } from './infrastructure/usage-recording/postgres-dispatch-attempt.repository';
import { PostgresUsageRepository } from './infrastructure/usage-recording/postgres-usage.repository';
import { PrometheusMeteringTelemetryAdapter } from './infrastructure/usage-recording/prometheus-metering-telemetry.adapter';
import { HttpExceptionFilter } from './presentation/http-exception.filter';

@Module({
  imports: [RuntimeConfigurationModule, PersistenceModule, SecretsModule],
  providers: [
    {
      provide: REDIS_METERING_CLIENT,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): RedisMeteringClient | undefined =>
        createRedisMeteringClient(configuration.redisUrl ?? ''),
    },
    {
      provide: MONTHLY_BILLABLE_USAGE,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): MonthlyBillableUsagePort =>
        new PostgresMonthlyBillableUsage(runtime.prisma),
    },
    {
      provide: RedisQuotaSeeder,
      inject: [REDIS_METERING_CLIENT, MONTHLY_BILLABLE_USAGE],
      useFactory: (
        client: RedisMeteringClient | undefined,
        source: MonthlyBillableUsagePort,
      ): RedisQuotaSeeder | undefined =>
        client === undefined ? undefined : new RedisQuotaSeeder(client, source),
    },
    {
      provide: QUOTA_COUNTER_SEED,
      useExisting: RedisQuotaSeeder,
    },
    {
      provide: QUOTA_COUNTER,
      useFactory: (
        client: RedisMeteringClient | undefined,
        seeder: RedisQuotaSeeder | undefined,
      ): QuotaCounterPort =>
        new RedisQuotaCounter(client, undefined, undefined, seeder),
      inject: [REDIS_METERING_CLIENT, RedisQuotaSeeder],
    },
    {
      provide: QUOTA_COUNTER_OVERWRITE,
      inject: [REDIS_METERING_CLIENT],
      useFactory: (
        client: RedisMeteringClient | undefined,
      ): QuotaCounterOverwritePort =>
        new RedisQuotaReconciliationCounter(client),
    },
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
    HttpExceptionFilter,
  ],
  exports: [
    METERING_FINALIZER,
    DISPATCH_ATTEMPT_RECORD,
    QUOTA_COUNTER_SEED,
    HttpExceptionFilter,
  ],
})
export class MeteringModule {}
