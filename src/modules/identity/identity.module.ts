import { Module } from '@nestjs/common';

import { ApiKeyAuthenticator } from './application/api-key-authenticator';
import {
  API_KEY_AUTHENTICATOR,
  API_KEY_CACHE,
  API_KEY_REPOSITORY,
  AUTH_FAILURE_COUNTER,
  type ApiKeyCachePort,
  type ApiKeyRepositoryPort,
  type AuthFailureCounterPort,
} from './application/api-key-authenticator.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from './application/organization-identity-config-repository.port';
import { PostgresApiKeyRepository } from './infrastructure/postgres-api-key.repository';
import { createPostgresIdentityClient } from './infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from './infrastructure/postgres-organization-identity-config.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from './infrastructure/redis-identity.store';
import { ApiKeyGuard } from './presentation/api-key.guard';

@Module({
  providers: [
    {
      provide: API_KEY_REPOSITORY,
      useFactory: () =>
        new PostgresApiKeyRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
      useFactory: (): OrganizationIdentityConfigRepositoryPort =>
        new PostgresOrganizationIdentityConfigRepository(
          createPostgresIdentityClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    {
      provide: API_KEY_CACHE,
      useFactory: () => new RedisIdentityStore(process.env.REDIS_URL ?? ''),
    },
    {
      provide: AUTH_FAILURE_COUNTER,
      useFactory: () =>
        new RedisAuthFailureCounter(process.env.REDIS_URL ?? ''),
    },
    {
      provide: API_KEY_AUTHENTICATOR,
      useFactory: (
        repository: ApiKeyRepositoryPort,
        cache: ApiKeyCachePort,
        failureCounter: AuthFailureCounterPort,
      ) => new ApiKeyAuthenticator(repository, cache, failureCounter),
      inject: [API_KEY_REPOSITORY, API_KEY_CACHE, AUTH_FAILURE_COUNTER],
    },
    ApiKeyGuard,
  ],
  exports: [
    API_KEY_AUTHENTICATOR,
    ApiKeyGuard,
    ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  ],
})
export class IdentityModule {}
