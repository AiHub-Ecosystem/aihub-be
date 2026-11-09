import { internalError } from '@/common/errors/app-error';
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
import {
  speakingV2PartGetAdapter,
  speakingV2PartGradingAdapter,
  speakingV2QuestionGradingAdapter,
  speakingV2ResponseGetAdapter,
  speakingV2TestGetAdapter,
  speakingV2TestGradingAdapter,
} from '@/downstream/speaking/speaking-v2.adapters';
import { task1GradeAdapter } from '@/downstream/writing/task1-grade.adapter';
import { task2GradeAdapter } from '@/downstream/writing/task2-grade.adapter';
import {
  createLongWritingExerciseAdapter,
  createMicroExerciseAdapter,
  gradeMicroExerciseAdapter,
} from '@/downstream/writing/writing-micro-exercises.adapters';
import {
  writingV3Task1GradeAdapter,
  writingV3Task2GradeAdapter,
} from '@/downstream/writing/writing-v3-grade.adapters';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
} from '@/modules/idempotency/application/idempotency-service.port';
import { IdempotencyModule } from '@/modules/idempotency/idempotency.module';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/usage-recording/metering-finalizer.port';
import { MeteringModule } from '@/modules/metering/metering.module';
import {
  DISPATCH_ATTEMPT_RECORD,
  type DispatchAttemptRecordPort,
} from '@/modules/metering/public/dispatch-attempts';
import {
  QUOTA_COUNTER_SEED,
  type QuotaCounterSeedPort,
} from '@/modules/metering/public/quota-counter';
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
} from './application/dispatch/downstream-retry-budget.port';
import { GuardedOperationDispatcher } from './application/dispatch/guarded-operation-dispatcher';
import { INTERNAL_TOKEN_ISSUER } from './application/dispatch/internal-token-issuer.port';
import {
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from './application/dispatch/operation-dispatcher.port';
import {
  GRADED_ADMISSION,
  type GradedAdmissionPort,
} from './application/graded-admission.port';
import { GradedPipelineEngine } from './application/graded-request/graded-pipeline-engine';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
} from './application/graded-request/graded-pipeline.port';
import { GradingOrchestrator } from './application/graded-request/grading-orchestrator';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
} from './application/graded-request/grading-orchestrator.port';
import {
  OUTSTANDING_QUOTA_RESERVATIONS,
  OutstandingQuotaReservationRegistry,
  type OutstandingQuotaReservationsPort,
} from './application/graded-request/outstanding-quota-reservations';
import { RATE_LIMITER } from './application/rate-limiter.port';
import { SandboxAdmission } from './application/sandbox-admission';
import {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxDispatchBudgetPort,
} from './application/sandbox-dispatch-budget.port';
import { ConfiguredTokenIssuer } from './infrastructure/dispatch/configured-token-issuer';
import { DownstreamCircuitBreakers } from './infrastructure/dispatch/downstream-circuit-breakers';
import { DownstreamHttpClient } from './infrastructure/dispatch/downstream-http.client';
import {
  DISPATCHER_LOG_CONTEXT,
  HttpOperationTransport,
} from './infrastructure/dispatch/http-operation-dispatcher';
import { metricsDispatchObserver } from './infrastructure/dispatch/metrics-dispatch-observer';
import { PostgresSandboxDispatchBudget } from './infrastructure/postgres-sandbox-dispatch-budget';
import { RedisConcurrencyLimiter } from './infrastructure/redis-concurrency-limiter';
import { RedisDownstreamRetryBudget } from './infrastructure/redis-downstream-retry-budget';
import {
  REDIS_GATEWAY_CLIENT,
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './infrastructure/redis-gateway.client';
import { RedisGradedAdmission } from './infrastructure/redis-graded-admission';
import { RedisRateLimiter } from './infrastructure/redis-rate-limiter';
import { RateLimitGuard } from './presentation/rate-limit.guard';
import { SuccessEnvelopeInterceptor } from './presentation/success-envelope.interceptor';

@Module({
  imports: [
    RuntimeConfigurationModule,
    SecretsModule,
    IdempotencyModule,
    MeteringModule,
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
            throw internalError('Redis is unavailable');
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
      provide: GRADED_ADMISSION,
      useFactory: (
        client: RedisGatewayClient | undefined,
        seeder: QuotaCounterSeedPort | undefined,
      ): RedisGradedAdmission =>
        new RedisGradedAdmission(
          client,
          undefined,
          undefined,
          undefined,
          seeder,
        ),
      inject: [REDIS_GATEWAY_CLIENT, QUOTA_COUNTER_SEED],
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
        const warn = (event: string): void => logger.warn({ event });
        return new GuardedOperationDispatcher(
          new HttpOperationTransport(
            httpClient,
            tokenIssuer,
            [
              task1GradeAdapter,
              task2GradeAdapter,
              writingV3Task1GradeAdapter,
              writingV3Task2GradeAdapter,
              createMicroExerciseAdapter,
              createLongWritingExerciseAdapter,
              gradeMicroExerciseAdapter,
              speakingGradingAdapter,
              speakingGradingJsonAdapter,
              speakingV2QuestionGradingAdapter,
              speakingV2PartGradingAdapter,
              speakingV2TestGradingAdapter,
              speakingV2ResponseGetAdapter,
              speakingV2PartGetAdapter,
              speakingV2TestGetAdapter,
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
    {
      provide: OUTSTANDING_QUOTA_RESERVATIONS,
      useFactory: (): OutstandingQuotaReservationRegistry =>
        new OutstandingQuotaReservationRegistry(),
    },
    {
      provide: GRADED_PIPELINE_ENGINE,
      inject: [
        GRADING_ORCHESTRATOR,
        METERING_FINALIZER,
        GRADED_ADMISSION,
        CONCURRENCY_LIMITER,
        IDEMPOTENCY_SERVICE,
        OUTSTANDING_QUOTA_RESERVATIONS,
      ],
      useFactory: (
        orchestrator: GradingOrchestratorPort,
        finalizer: MeteringFinalizerPort,
        admission: GradedAdmissionPort,
        concurrencyLimiter: ConcurrencyLimiterPort,
        idempotency: IdempotencyServicePort,
        reservations: OutstandingQuotaReservationsPort,
      ): GradedPipelineEnginePort =>
        new GradedPipelineEngine(
          orchestrator,
          finalizer,
          admission,
          concurrencyLimiter,
          idempotency,
          reservations,
        ),
    },
    SuccessEnvelopeInterceptor,
    RateLimitGuard,
  ],
  exports: [
    GATEWAY_REDIS_READINESS,
    SANDBOX_DISPATCH_BUDGET,
    DOWNSTREAM_RETRY_BUDGET,
    OPERATION_DISPATCHER,
    GRADING_ORCHESTRATOR,
    GRADED_PIPELINE_ENGINE,
    OUTSTANDING_QUOTA_RESERVATIONS,
    DownstreamHttpClient,
    RATE_LIMITER,
    GRADED_ADMISSION,
    RateLimitGuard,
    SuccessEnvelopeInterceptor,
    CONCURRENCY_LIMITER,
  ],
})
export class GatewayModule {}
