import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

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
import { GradingOrchestrator } from './application/grading-orchestrator';
import { GRADING_ORCHESTRATOR } from './application/grading-orchestrator.port';
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
import {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxDispatchBudgetPort,
} from './application/sandbox-dispatch-budget.port';
import { ConfiguredTokenIssuer } from './infrastructure/configured-token-issuer';
import { DownstreamHttpClient } from './infrastructure/downstream-http.client';
import { HttpOperationDispatcher } from './infrastructure/http-operation-dispatcher';
import { PostgresSandboxDispatchBudget } from './infrastructure/postgres-sandbox-dispatch-budget';
import { RedisConcurrencyLimiter } from './infrastructure/redis-concurrency-limiter';
import {
  REDIS_GATEWAY_CLIENT,
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './infrastructure/redis-gateway.client';
import { RedisQuotaCounter } from './infrastructure/redis-quota-counter';
import { RedisRateLimiter } from './infrastructure/redis-rate-limiter';
import { ConcurrencyPermitInterceptor } from './presentation/concurrency-permit.interceptor';
import { QuotaGuard } from './presentation/quota.guard';
import { RateLimitGuard } from './presentation/rate-limit.guard';

@Module({
  imports: [RuntimeConfigurationModule, SecretsModule, IdempotencyModule],
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
      provide: CONCURRENCY_LIMITER,
      useFactory: (
        client: RedisGatewayClient | undefined,
      ): ConcurrencyLimiterPort => new RedisConcurrencyLimiter(client),
      inject: [REDIS_GATEWAY_CLIENT],
    },
    {
      provide: QUOTA_COUNTER,
      useFactory: (client: RedisGatewayClient | undefined): QuotaCounterPort =>
        new RedisQuotaCounter(client),
      inject: [REDIS_GATEWAY_CLIENT],
    },
    {
      provide: SANDBOX_DISPATCH_BUDGET,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): SandboxDispatchBudgetPort =>
        new PostgresSandboxDispatchBudget(configuration.databaseUrl ?? ''),
    },
    {
      provide: OPERATION_DISPATCHER,
      useFactory: (
        httpClient: DownstreamHttpClient,
        tokenIssuer: ConfiguredTokenIssuer,
        sandboxBudget: SandboxDispatchBudgetPort,
      ): HttpOperationDispatcher =>
        new HttpOperationDispatcher(
          httpClient,
          tokenIssuer,
          [
            task1GradeAdapter,
            task2GradeAdapter,
            speakingGradingAdapter,
            speakingGradingJsonAdapter,
          ],
          sandboxBudget,
        ),
      inject: [
        DownstreamHttpClient,
        INTERNAL_TOKEN_ISSUER,
        SANDBOX_DISPATCH_BUDGET,
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
    QuotaGuard,
    ConcurrencyPermitInterceptor,
  ],
  exports: [
    OPERATION_DISPATCHER,
    GRADING_ORCHESTRATOR,
    DownstreamHttpClient,
    RATE_LIMITER,
    RateLimitGuard,
    QUOTA_COUNTER,
    QuotaGuard,
    CONCURRENCY_LIMITER,
    ConcurrencyPermitInterceptor,
  ],
})
export class GatewayModule {}
