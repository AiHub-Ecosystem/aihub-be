import { Module } from '@nestjs/common';

import { AuthModule } from '@/modules/auth/auth.module';
import {
  AUTH_POSTGRES_READINESS,
  type AuthPostgresReadiness,
} from '@/modules/auth/public/postgres-readiness';
import { GatewayModule } from '@/modules/gateway/gateway.module';
import {
  GATEWAY_REDIS_READINESS,
  type GatewayRedisReadiness,
} from '@/modules/gateway/public/redis-readiness';
import { IdentityModule } from '@/modules/identity/identity.module';
import {
  IDENTITY_POSTGRES_READINESS,
  type IdentityPostgresReadiness,
} from '@/modules/identity/public/postgres-readiness';
import {
  RUNTIME_CONNECTION_CONFIGURATION,
  type RuntimeConnectionConfigurationPort,
} from '@/modules/secrets/application/runtime-connection-configuration.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';

import { HealthController } from './health.controller';
import { READINESS_PROBES, type ReadinessProbe } from './readiness-probes';
import { ReadinessTerminusModule } from './readiness-terminus.module';

export function uniquePostgresProbes(
  probes: readonly ReadinessProbe[],
): ReadinessProbe[] {
  const seenUrls = new Set<string>();
  return probes.filter((probe) => {
    const url = probe.databaseUrl?.trim();
    if (url === undefined || url.length === 0) {
      return true;
    }
    if (seenUrls.has(url)) {
      return false;
    }
    seenUrls.add(url);
    return true;
  });
}

@Module({
  imports: [
    ReadinessTerminusModule,
    SecretsModule,
    AuthModule,
    GatewayModule,
    IdentityModule,
  ],
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_PROBES,
      inject: [
        RUNTIME_CONNECTION_CONFIGURATION,
        AUTH_POSTGRES_READINESS,
        IDENTITY_POSTGRES_READINESS,
        GATEWAY_REDIS_READINESS,
      ],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
        runtimePostgres: AuthPostgresReadiness,
        identityPostgres: IdentityPostgresReadiness,
        redis: GatewayRedisReadiness,
      ): ReadinessProbe[] =>
        uniquePostgresProbes([
          {
            name: 'runtime-postgres',
            databaseUrl: configuration.databaseUrl,
            check: (timeoutMs) => runtimePostgres.check(timeoutMs),
          },
          {
            name: 'control-plane-write-postgres',
            databaseUrl: configuration.controlPlaneDatabaseUrl,
            check: (timeoutMs) =>
              identityPostgres.checkControlPlaneWrite(timeoutMs),
          },
          {
            name: 'control-plane-read-postgres',
            databaseUrl: configuration.controlPlaneReadDatabaseUrl,
            check: (timeoutMs) =>
              identityPostgres.checkControlPlaneRead(timeoutMs),
          },
          { name: 'redis', check: () => redis.check() },
        ]),
    },
  ],
})
export class HealthModule {}
