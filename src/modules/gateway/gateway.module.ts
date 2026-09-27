import { Module } from '@nestjs/common';

import { speakingGradingJsonAdapter } from '../../downstream/speaking/speaking-grading-json.adapter';
import { speakingGradingAdapter } from '../../downstream/speaking/speaking-grading.adapter';
import { task1GradeAdapter } from '../../downstream/writing/task1-grade.adapter';
import { task2GradeAdapter } from '../../downstream/writing/task2-grade.adapter';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '../secrets/application/runtime-secret-provider.port';
import { SecretsModule } from '../secrets/secrets.module';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from './application/concurrency-limiter.port';
import { INTERNAL_TOKEN_ISSUER } from './application/internal-token-issuer.port';
import { OPERATION_DISPATCHER } from './application/operation-dispatcher.port';
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
import { ConcurrencyReleaseInterceptor } from './presentation/concurrency-release.interceptor';
import { ConcurrencyGuard } from './presentation/concurrency.guard';
import { QuotaGuard } from './presentation/quota.guard';
import { RateLimitGuard } from './presentation/rate-limit.guard';

@Module({
  imports: [SecretsModule],
  providers: [
    {
      provide: REDIS_GATEWAY_CLIENT,
      useFactory: (): RedisGatewayClient | undefined =>
        createRedisGatewayClient(process.env.REDIS_URL ?? ''),
    },
    {
      provide: DownstreamHttpClient,
      useFactory: (
        secretProvider: RuntimeSecretProvider,
      ): DownstreamHttpClient => {
        const secrets = secretProvider.getSnapshot();
        return new DownstreamHttpClient(
          {
            'ai-writing': process.env.DOWNSTREAM_AI_WRITING_URL ?? '',
            'ai-speaking': process.env.DOWNSTREAM_AI_SPEAKING_URL ?? '',
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
      inject: [RUNTIME_SECRET_PROVIDER],
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
      useFactory: (): SandboxDispatchBudgetPort =>
        new PostgresSandboxDispatchBudget(process.env.DATABASE_URL ?? ''),
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
    RateLimitGuard,
    QuotaGuard,
    ConcurrencyGuard,
    ConcurrencyReleaseInterceptor,
  ],
  exports: [
    OPERATION_DISPATCHER,
    DownstreamHttpClient,
    RATE_LIMITER,
    RateLimitGuard,
    QUOTA_COUNTER,
    QuotaGuard,
    CONCURRENCY_LIMITER,
    ConcurrencyGuard,
    ConcurrencyReleaseInterceptor,
  ],
})
export class GatewayModule {}
