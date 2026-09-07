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
import { JWKS_CACHE, type JwksCachePort } from './application/jwks-cache.port';
import {
  JWKS_KEY_PROVIDER,
  type JwksKeyProviderPort,
} from './application/jwks-key-provider.port';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from './application/organization-identity-config-repository.port';
import {
  USER_ASSERTION_CRYPTO,
  type UserAssertionCryptoPort,
} from './application/user-assertion-crypto.port';
import { UserAssertionVerifier } from './application/user-assertion-verifier';
import { USER_ASSERTION_VERIFIER } from './application/user-assertion-verifier.port';
import { JoseUserAssertionCrypto } from './infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from './infrastructure/jwks-key-provider';
import { PostgresApiKeyRepository } from './infrastructure/postgres-api-key.repository';
import { createPostgresIdentityClient } from './infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from './infrastructure/postgres-organization-identity-config.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from './infrastructure/redis-identity.store';
import { ApiKeyGuard } from './presentation/api-key.guard';
import { UserAssertionGuard } from './presentation/user-assertion.guard';

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
      provide: JWKS_CACHE,
      useExisting: API_KEY_CACHE,
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
    {
      provide: JWKS_KEY_PROVIDER,
      useFactory: (cache: JwksCachePort): JwksKeyProviderPort =>
        new JwksKeyProvider(cache),
      inject: [JWKS_CACHE],
    },
    {
      provide: USER_ASSERTION_VERIFIER,
      useFactory: (
        repository: OrganizationIdentityConfigRepositoryPort,
        keyProvider: JwksKeyProviderPort,
        crypto: UserAssertionCryptoPort,
      ) => new UserAssertionVerifier(repository, keyProvider, crypto),
      inject: [
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
        JWKS_KEY_PROVIDER,
        USER_ASSERTION_CRYPTO,
      ],
    },
    {
      provide: USER_ASSERTION_CRYPTO,
      useClass: JoseUserAssertionCrypto,
    },
    ApiKeyGuard,
    UserAssertionGuard,
  ],
  exports: [
    API_KEY_AUTHENTICATOR,
    ApiKeyGuard,
    UserAssertionGuard,
    ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
    USER_ASSERTION_VERIFIER,
  ],
})
export class IdentityModule {}
