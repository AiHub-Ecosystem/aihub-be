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
import { MintSandboxAssertion } from './application/mint-sandbox-assertion';
import {
  ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
  type OrganizationIdentityConfigRepositoryPort,
} from './application/organization-identity-config-repository.port';
import { SANDBOX_ASSERTION_MINTER } from './application/sandbox-assertion-minter.port';
import { SANDBOX_ASSERTION_POLICY } from './application/sandbox-assertion-policy.port';
import {
  SANDBOX_ASSERTION_SIGNER,
  type SandboxAssertionSignerPort,
} from './application/sandbox-assertion-signer.port';
import {
  USER_ASSERTION_CRYPTO,
  type UserAssertionCryptoPort,
} from './application/user-assertion-crypto.port';
import { UserAssertionVerifier } from './application/user-assertion-verifier';
import { USER_ASSERTION_VERIFIER } from './application/user-assertion-verifier.port';
import { EnvSandboxAssertionPolicy } from './infrastructure/env-sandbox-assertion-policy';
import { JoseSandboxAssertionSigner } from './infrastructure/jose-sandbox-assertion-signer';
import { JoseUserAssertionCrypto } from './infrastructure/jose-user-assertion-crypto';
import { JwksKeyProvider } from './infrastructure/jwks-key-provider';
import { PostgresApiKeyRepository } from './infrastructure/postgres-api-key.repository';
import { createPostgresIdentityClient } from './infrastructure/postgres-identity.client';
import { PostgresOrganizationIdentityConfigRepository } from './infrastructure/postgres-organization-identity-config.repository';
import {
  RedisAuthFailureCounter,
  RedisIdentityStore,
} from './infrastructure/redis-identity.store';
import { readSandboxAssertionConfig } from './infrastructure/sandbox-assertion.config';
import { ApiKeyGuard } from './presentation/api-key.guard';
import { SandboxApiKeyGuard } from './presentation/sandbox-api-key.guard';
import { SandboxAssertionController } from './presentation/sandbox-assertion.controller';
import { UserAssertionGuard } from './presentation/user-assertion.guard';

@Module({
  controllers: [SandboxAssertionController],
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
    {
      provide: SANDBOX_ASSERTION_POLICY,
      useClass: EnvSandboxAssertionPolicy,
    },
    {
      // Built even when no sandbox is configured, because the environment is
      // not loaded yet when this module is evaluated. `SandboxApiKeyGuard`
      // rejects the request with 404 before the minter is ever reached, so an
      // unconfigured deployment holds a signer that cannot be called.
      provide: SANDBOX_ASSERTION_SIGNER,
      useFactory: (): SandboxAssertionSignerPort =>
        new JoseSandboxAssertionSigner(
          readSandboxAssertionConfig() ?? {
            organizationIds: [],
            privateKeyPem: '',
            keyId: '',
            algorithm: 'RS256',
          },
        ),
    },
    {
      provide: SANDBOX_ASSERTION_MINTER,
      useFactory: (
        repository: OrganizationIdentityConfigRepositoryPort,
        signer: SandboxAssertionSignerPort,
      ) => new MintSandboxAssertion(repository, signer),
      inject: [
        ORGANIZATION_IDENTITY_CONFIG_REPOSITORY,
        SANDBOX_ASSERTION_SIGNER,
      ],
    },
    ApiKeyGuard,
    SandboxApiKeyGuard,
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
