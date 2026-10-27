import { Logger, Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  GATEWAY_REDIS_READINESS,
  type GatewayRedisReadiness,
} from './public/redis-readiness';

import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { speakingGradingJsonAdapter } from '@/downstream/speaking/speaking-grading-json.adapter';
import { speakingGradingAdapter } from '@/downstream/speaking/speaking-grading.adapter';
import { task1GradeAdapter } from '@/downstream/writing/task1-grade.adapter';
import { task2GradeAdapter } from '@/downstream/writing/task2-grade.adapter';
import { IDEMPOTENCY_SERVICE } from '@/modules/idempotency/application/idempotency-service.port';
import type { IdempotencyServicePort } from '@/modules/idempotency/application/idempotency-service.port';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import {
  DISPATCH_ATTEMPT_RECORD,
  DispatchAttemptModule,
  type DispatchAttemptRecordPort,
} from '@/modules/metering/public/dispatch-attempts';
import {
  MONTHLY_BILLABLE_USAGE,
  MonthlyBillableUsageModule,
  type MonthlyBillableUsagePort,
} from '@/modules/metering/public/quota-reconciliation';
import {
  PersistenceModule,
  type PrismaClientHolder,
  RUNTIME_PRISMA_CLIENT,
} from '@/modules/persistence/persistence.module';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '@/modules/secrets/application/runtime-secret-provider.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from './application/concurrency-limiter.port';
import {
  DOWNSTREAM_RETRY_BUDGET,
  type DownstreamRetryBudgetPort,
} from './application/downstream-retry-budget.port';
import { GRADED_ADMISSION } from './application/graded-admission.port';
import { GradingOrchestrator } from './application/grading-orchestrator';
import { GRADING_ORCHESTRATOR } from './application/grading-orchestrator.port';
import { GuardedOperationDispatcher } from './application/guarded-operation-dispatcher';
import { INTERNAL_TOKEN_ISSUER } from './application/internal-token-issuer.port';
import {
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from './application/operation-dispatcher.port';
import {
  QUOTA_COUNTER,
  type QuotaCounterPort,
} from './application/quota-counter.port';
import { RATE_LIMITER } from './application/rate-limiter.port';
import { SandboxAdmission } from './application/sandbox-admission';
import {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxDispatchBudgetPort,
} from './application/sandbox-dispatch-budget.port';
import { ConfiguredTokenIssuer } from './infrastructure/configured-token-issuer';
import { DownstreamCircuitBreakers } from './infrastructure/downstream-circuit-breakers';
import { DownstreamHttpClient } from './infrastructure/downstream-http.client';
import {
  DISPATCHER_LOG_CONTEXT,
  HttpOperationTransport,
} from './infrastructure/http-operation-dispatcher';
import { metricsDispatchObserver } from './infrastructure/metrics-dispatch-observer';
import { PostgresSandboxDispatchBudget } from './infrastructure/postgres-sandbox-dispatch-budget';
import { RedisConcurrencyLimiter } from './infrastructure/redis-concurrency-limiter';
import { RedisDownstreamRetryBudget } from './infrastructure/redis-downstream-retry-budget';
import {
  REDIS_GATEWAY_CLIENT,
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from './infrastructure/redis-graded-admission';
import { RedisQuotaCounter } from './infrastructure/redis-quota-counter';
import { RedisQuotaSeeder } from './infrastructure/redis-quota-seed';
import { RedisRateLimiter } from './infrastructure/redis-rate-limiter';
import { ConcurrencyPermitInterceptor } from './presentation/concurrency-permit.interceptor';
import { GradedAdmissionGuard } from './presentation/graded-admission.guard';
import { RateLimitGuard } from './presentation/rate-limit.guard';

@Module({
  imports: [
    RuntimeConfigurationModule,
    SecretsModule,
    IdempotencyModule,
    DispatchAttemptModule,
    MonthlyBillableUsageModule,
    PersistenceModule,
  ],
  providers: [
    {
      provide: REDIS_GATEWAY_CLIENT,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): RedisGatewayClient | undefined =>
        createRedisGatewayClient(configuration.redisUrl ?? ''),
    },
    {
      provide: GATEWAY_REDIS_READINESS,
      inject: [REDIS_GATEWAY_CLIENT],
      useFactory: (
        client: RedisGatewayClient | undefined,
      ): GatewayRedisReadiness => ({
        async check() {
          if (client === undefined || (await client.ping()) !== 'PONG') {
            throw new Error('Redis is unavailable');
          }
        },
      }),
    },
    {
      provide: DownstreamHttpClient,
      useFactory: (
        secretProvider: RuntimeSecretProvider,
        configuration: ConfigType<typeof appConfig>,
      ): DownstreamHttpClient => {
        const secrets = secretProvider.getSnapshot();
        return new DownstreamHttpClient(
          {
            'ai-writing': configuration.DOWNSTREAM_AI_WRITING_URL ?? '',
            'ai-speaking': configuration.DOWNSTREAM_AI_SPEAKING_URL ?? '',
          },
          undefined,
          {
            'ai-speaking': {
              'x-client-id': secrets.aiSpeaking.clientId,
              'x-secret-key': secrets.aiSpeaking.secretKey,
            },
          },
        );
      },
      inject: [RUNTIME_SECRET_PROVIDER, appConfig.KEY],
    },
    {
      provide: INTERNAL_TOKEN_ISSUER,
      useFactory: (
        secretProvider: RuntimeSecretProvider,
      ): ConfiguredTokenIssuer =>
        new ConfiguredTokenIssuer(secretProvider.getSnapshot().aiWriting.token),
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    {
      provide: RATE_LIMITER,
      useFactory: (client: RedisGatewayClient | undefined): RedisRateLimiter =>
        new RedisRateLimiter('', client),
      inject: [REDIS_GATEWAY_CLIENT],
    },
    {
      provide: RedisQuotaSeeder,
      inject: [REDIS_GATEWAY_CLIENT, MONTHLY_BILLABLE_USAGE],
      useFactory: (
        client: RedisGatewayClient | undefined,
        source: MonthlyBillableUsagePort,
      ): RedisQuotaSeeder | undefined =>
        client === undefined ? undefined : new RedisQuotaSeeder(client, source),
    },
    {
      provide: GRADED_ADMISSION,
      useFactory: (
        client: RedisGatewayClient | undefined,
        seeder: RedisQuotaSeeder | undefined,
      ): RedisGradedAdmission =>
        new RedisGradedAdmission(
          client,
          undefined,
          undefined,
          undefined,
          seeder,
        ),
      inject: [REDIS_GATEWAY_CLIENT, RedisQuotaSeeder],
    },
    {
      provide: DOWNSTREAM_RETRY_BUDGET,
      useFactory: (client: RedisGatewayClient | undefined) => {
        // Keep retries off until #273/#327 ground each service bucket.
        return new RedisDownstreamRetryBudget(client);
      },
      inject: [REDIS_GATEWAY_CLIENT],
    },
    {
      provide: CONCURRENCY_LIMITER,
      useFactory: (
        client: RedisGatewayClient | undefined,
      ): ConcurrencyLimiterPort => new RedisConcurrencyLimiter(client),
      inject: [REDIS_GATEWAY_CLIENT],
    },
    {
      provide: QUOTA_COUNTER,
      useFactory: (
        client: RedisGatewayClient | undefined,
        seeder: RedisQuotaSeeder | undefined,
      ): QuotaCounterPort =>
        new RedisQuotaCounter(client, undefined, undefined, seeder),
      inject: [REDIS_GATEWAY_CLIENT, RedisQuotaSeeder],
    },
    {
      provide: SANDBOX_DISPATCH_BUDGET,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): SandboxDispatchBudgetPort =>
        new PostgresSandboxDispatchBudget(runtime.prisma),
    },
    DownstreamCircuitBreakers,
    {
      provide: OPERATION_DISPATCHER,
      useFactory: (
        httpClient: DownstreamHttpClient,
        tokenIssuer: ConfiguredTokenIssuer,
        dispatchAttempts: DispatchAttemptRecordPort,
        sandboxBudget: SandboxDispatchBudgetPort,
        retryBudget: DownstreamRetryBudgetPort,
        circuitBreakers: DownstreamCircuitBreakers,
      ): OperationDispatcherPort => {
        const logger = new Logger(DISPATCHER_LOG_CONTEXT);
        const warn = (message: string): void => logger.warn(message);
        return new GuardedOperationDispatcher(
          new HttpOperationTransport(
            httpClient,
            tokenIssuer,
            [
              task1GradeAdapter,
              task2GradeAdapter,
              speakingGradingAdapter,
              speakingGradingJsonAdapter,
            ],
            circuitBreakers,
            retryBudget,
            Math.random,
          ),
          dispatchAttempts,
          new SandboxAdmission(sandboxBudget, warn),
          metricsDispatchObserver,
          warn,
        );
      },
      inject: [
        DownstreamHttpClient,
        INTERNAL_TOKEN_ISSUER,
        DISPATCH_ATTEMPT_RECORD,
        SANDBOX_DISPATCH_BUDGET,
        DOWNSTREAM_RETRY_BUDGET,
        DownstreamCircuitBreakers,
      ],
    },
    {
      provide: GRADING_ORCHESTRATOR,
      useFactory: (
        dispatcher: OperationDispatcherPort,
        idempotency: IdempotencyServicePort,
      ): GradingOrchestrator =>
        new GradingOrchestrator(dispatcher, idempotency),
      inject: [OPERATION_DISPATCHER, IDEMPOTENCY_SERVICE],
    },
    RateLimitGuard,
    GradedAdmissionGuard,
    ConcurrencyPermitInterceptor,
  ],
  exports: [
    GATEWAY_REDIS_READINESS,
    SANDBOX_DISPATCH_BUDGET,
    DOWNSTREAM_RETRY_BUDGET,
    OPERATION_DISPATCHER,
    GRADING_ORCHESTRATOR,
    DownstreamHttpClient,
    RATE_LIMITER,
    GRADED_ADMISSION,
    RateLimitGuard,
    GradedAdmissionGuard,
    QUOTA_COUNTER,
    CONCURRENCY_LIMITER,
    ConcurrencyPermitInterceptor,
  ],
})
export class GatewayModule {}
