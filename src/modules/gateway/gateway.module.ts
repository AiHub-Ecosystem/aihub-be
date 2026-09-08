import { Module } from '@nestjs/common';

import { task1GradeAdapter } from '../../downstream/writing/task1-grade.adapter';
import { task1QuestionAdapter } from '../../downstream/writing/task1-question.adapter';
import { task2GradeAdapter } from '../../downstream/writing/task2-grade.adapter';
import { task2QuestionAdapter } from '../../downstream/writing/task2-question.adapter';
import {
  CONCURRENCY_LIMITER,
  type ConcurrencyLimiterPort,
} from './application/concurrency-limiter.port';
import { INTERNAL_TOKEN_ISSUER } from './application/internal-token-issuer.port';
import { OPERATION_DISPATCHER } from './application/operation-dispatcher.port';
import { RATE_LIMITER } from './application/rate-limiter.port';
import { ConfiguredTokenIssuer } from './infrastructure/configured-token-issuer';
import { DownstreamHttpClient } from './infrastructure/downstream-http.client';
import { HttpOperationDispatcher } from './infrastructure/http-operation-dispatcher';
import { RedisConcurrencyLimiter } from './infrastructure/redis-concurrency-limiter';
import {
  REDIS_GATEWAY_CLIENT,
  type RedisGatewayClient,
  createRedisGatewayClient,
} from './infrastructure/redis-gateway.client';
import { RedisRateLimiter } from './infrastructure/redis-rate-limiter';
import { ConcurrencyReleaseInterceptor } from './presentation/concurrency-release.interceptor';
import { ConcurrencyGuard } from './presentation/concurrency.guard';
import { RateLimitGuard } from './presentation/rate-limit.guard';

@Module({
  providers: [
    {
      provide: REDIS_GATEWAY_CLIENT,
      useFactory: (): RedisGatewayClient | undefined =>
        createRedisGatewayClient(process.env.REDIS_URL ?? ''),
    },
    {
      provide: DownstreamHttpClient,
      useFactory: (): DownstreamHttpClient =>
        new DownstreamHttpClient(process.env.DOWNSTREAM_AI_WRITING_URL ?? ''),
    },
    {
      provide: INTERNAL_TOKEN_ISSUER,
      useFactory: (): ConfiguredTokenIssuer =>
        new ConfiguredTokenIssuer(
          process.env.DOWNSTREAM_AI_WRITING_TOKEN ?? '',
        ),
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
      provide: OPERATION_DISPATCHER,
      useFactory: (
        httpClient: DownstreamHttpClient,
        tokenIssuer: ConfiguredTokenIssuer,
      ): HttpOperationDispatcher =>
        new HttpOperationDispatcher(httpClient, tokenIssuer, [
          task1QuestionAdapter,
          task2QuestionAdapter,
          task1GradeAdapter,
          task2GradeAdapter,
        ]),
      inject: [DownstreamHttpClient, INTERNAL_TOKEN_ISSUER],
    },
    RateLimitGuard,
    ConcurrencyGuard,
    ConcurrencyReleaseInterceptor,
  ],
  exports: [
    OPERATION_DISPATCHER,
    DownstreamHttpClient,
    RATE_LIMITER,
    RateLimitGuard,
    CONCURRENCY_LIMITER,
    ConcurrencyGuard,
    ConcurrencyReleaseInterceptor,
  ],
})
export class GatewayModule {}
