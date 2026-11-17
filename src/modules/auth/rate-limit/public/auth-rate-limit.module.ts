import { Module } from '@nestjs/common';

import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { AUTH_RATE_LIMITER } from '@/modules/auth/rate-limit/application/auth-rate-limiter.port';
import { RedisAuthRateLimiter } from '@/modules/auth/rate-limit/infrastructure/redis-auth-rate-limiter';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';

@Module({
  imports: [RuntimeConfigurationModule, SecretsModule],
  providers: [
    {
      provide: AUTH_RATE_LIMITER,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (configuration: RuntimeConnectionConfigurationPort) =>
        new RedisAuthRateLimiter(configuration.redisUrl ?? ''),
    },
  ],
  exports: [AUTH_RATE_LIMITER],
})
export class AuthRateLimitModule {}
