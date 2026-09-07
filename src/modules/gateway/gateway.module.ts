import { Module } from "@nestjs/common";

import { task1QuestionAdapter } from "../../downstream/writing/task1-question.adapter";
import { INTERNAL_TOKEN_ISSUER } from "./application/internal-token-issuer.port";
import { OPERATION_DISPATCHER } from "./application/operation-dispatcher.port";
import { RATE_LIMITER } from "./application/rate-limiter.port";
import { ConfiguredTokenIssuer } from "./infrastructure/configured-token-issuer";
import { DownstreamHttpClient } from "./infrastructure/downstream-http.client";
import { HttpOperationDispatcher } from "./infrastructure/http-operation-dispatcher";
import { RedisRateLimiter } from "./infrastructure/redis-rate-limiter";
import { RateLimitGuard } from "./presentation/rate-limit.guard";

@Module({
  providers: [
    {
      provide: DownstreamHttpClient,
      useFactory: (): DownstreamHttpClient =>
        new DownstreamHttpClient(process.env.DOWNSTREAM_AI_WRITING_URL ?? ""),
    },
    {
      provide: INTERNAL_TOKEN_ISSUER,
      useFactory: (): ConfiguredTokenIssuer =>
        new ConfiguredTokenIssuer(
          process.env.DOWNSTREAM_AI_WRITING_TOKEN ?? ""
        ),
    },
    {
      provide: RATE_LIMITER,
      useFactory: (): RedisRateLimiter =>
        new RedisRateLimiter(process.env.REDIS_URL ?? ""),
    },
    {
      provide: OPERATION_DISPATCHER,
      useFactory: (
        httpClient: DownstreamHttpClient,
        tokenIssuer: ConfiguredTokenIssuer
      ): HttpOperationDispatcher =>
        new HttpOperationDispatcher(
          httpClient,
          tokenIssuer,
          task1QuestionAdapter
        ),
      inject: [DownstreamHttpClient, INTERNAL_TOKEN_ISSUER],
    },
    RateLimitGuard,
  ],
  exports: [
    OPERATION_DISPATCHER,
    DownstreamHttpClient,
    RATE_LIMITER,
    RateLimitGuard,
  ],
})
export class GatewayModule {}
