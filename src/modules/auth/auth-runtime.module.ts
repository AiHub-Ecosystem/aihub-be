import { internalError } from '@/common/errors/app-error';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import Redis from 'ioredis';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { createRedisClient } from '@/common/redis/create-redis-client';
import {
  OPAQUE_TOKEN_BINDINGS,
  opaqueTokenIssuer,
} from '@/common/security/opaque-token-issuer';
import {
  appConfig,
  getRuntimeSecretEnvironment,
} from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
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
import { USER_ACCOUNT_REPOSITORY } from './accounts/application/user-account.port';
import { PostgresUserAccountRepository } from './accounts/infrastructure/postgres-user-account.repository';
import {
  EMAIL_OUTBOX,
  type EmailOutboxPort,
} from './email-delivery/application/email-outbox.port';
import { EmailDeliveryModule } from './email-delivery/email-delivery.module';
import { PASSWORD_CHANGE_REPOSITORY } from './local-credentials/application/password-change-repository.port';
import { PASSWORD_HASHER } from './local-credentials/application/password-hasher.port';
import { Argon2PasswordHasher } from './local-credentials/infrastructure/argon2-password.hasher';
import { PostgresPasswordChangeRepository } from './local-credentials/infrastructure/postgres-password-change.repository';
import {
  AUTH_MFA_CIPHER,
  AUTH_MFA_ID,
  AUTH_MFA_REPOSITORY,
  AUTH_MFA_SERVICE,
} from './mfa/application/auth-mfa-repository.port';
import { AuthMfaService } from './mfa/application/auth-mfa.service';
import { createAuthMfaCipher } from './mfa/infrastructure/auth-mfa-secret.cipher';
import { PostgresAuthMfaRepository } from './mfa/infrastructure/postgres-auth-mfa.repository';
import { MfaController } from './mfa/presentation/mfa.controller';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from './password-reset/application/password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from './password-reset/application/password-reset-token.port';
import { PostgresPasswordResetTokenRepository } from './password-reset/infrastructure/postgres-password-reset-token.repository';
import {
  AUTH_POSTGRES_READINESS,
  type AuthPostgresReadiness,
} from './public/postgres-readiness';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './rate-limit/application/auth-rate-limiter.port';
import { RedisAuthRateLimiter } from './rate-limit/infrastructure/redis-auth-rate-limiter';
import { AUTH_CLOCK, type AuthClock } from './shared/application/auth-clock';
import { AUTH_SECURITY_EVENT_RECORDER } from './shared/application/auth-security-event.port';
import { AuthSecurityEventRecorder } from './shared/infrastructure/auth-security-event-recorder';
import {
  REVOKE_USER_ACCESS_TOKEN,
  type RevokeUserAccessTokenPort,
} from './user-access-tokens/application/revoke-user-access-token.port';
import { RevokeUserAccessTokenService } from './user-access-tokens/application/revoke-user-access-token.service';
import { USER_ACCESS_TOKEN_REVOCATION_RECORD } from './user-access-tokens/application/user-access-token-revocation-record.port';
import { BloomFilterUserAccessTokenRevocationAdapter } from './user-access-tokens/infrastructure/bloom-filter/bloom-filter-user-access-token-revocation.adapter';
import { PostgresUserAccessTokenRevocationRepository } from './user-access-tokens/infrastructure/postgres-user-access-token-revocation.repository';
import { UserAccessTokenController } from './user-access-tokens/presentation/user-access-token.controller';
import { VERIFICATION_TOKEN_REPOSITORY } from './verification/application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from './verification/application/verification-token.port';
import { PostgresVerificationTokenRepository } from './verification/infrastructure/postgres-verification-token.repository';
import { REFRESH_SESSION_REPOSITORY } from './web-sessions/application/refresh-session-repository.port';
import { REFRESH_TOKEN_ISSUER } from './web-sessions/application/refresh-token.port';
import { userAccessTokenAudience } from './web-sessions/application/user-access-token-audience';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
} from './web-sessions/application/user-access-token.port';
import {
  WEB_SESSION_CLIENT_SECRET,
  type WebSessionClientSecretPort,
} from './web-sessions/application/web-session-client-secret.port';
import { WEB_SESSION_ID } from './web-sessions/application/web-session-id.port';
import { WEB_SESSION_POLICY } from './web-sessions/application/web-session-policy';
import { WEB_SESSION_REPOSITORY } from './web-sessions/application/web-session-repository.port';
import { WEB_SESSION_SERVICE } from './web-sessions/application/web-session-service.port';
import {
  WEB_SESSION_TOKEN_ISSUER,
  type WebSessionTokenIssuerPort,
} from './web-sessions/application/web-session-token.port';
import { WebSessionService } from './web-sessions/application/web-session.service';
import { CryptoRefreshToken } from './web-sessions/infrastructure/crypto-refresh-token';
import {
  JoseUserAccessTokenService,
  USER_ACCESS_TOKEN_CRYPTO,
} from './web-sessions/infrastructure/jose-user-access-token.service';
import { PostgresRefreshSessionRepository } from './web-sessions/infrastructure/postgres-refresh-session.repository';
import { PostgresWebSessionRepository } from './web-sessions/infrastructure/postgres-web-session.repository';
import { UserAccessJwtGuard } from './web-sessions/presentation/user-access-jwt.guard';
import {
  OptionalWebSessionClientGuard,
  WebSessionClientGuard,
} from './web-sessions/presentation/web-session-client.guard';
import { WebSessionController } from './web-sessions/presentation/web-session.controller';

/** Binds access-token verification to the configured database scope. */
function createUserAccessTokenCrypto(
  provider: RuntimeSecretProvider,
  configuration: ConfigType<typeof appConfig>,
): JoseUserAccessTokenService {
  const issuer = configuration.AIHUB_USER_ACCESS_ISSUER?.trim();
  if (issuer === undefined || issuer.length === 0) {
    throw internalError('AIHUB_USER_ACCESS_ISSUER is required');
  }
  const runtime = provider.getSnapshot().userAccessJwt;
  return new JoseUserAccessTokenService({
    privateKeyPem: runtime.privateKeyPem,
    keyId: runtime.keyId,
    issuer,
    audience: userAccessTokenAudience(
      configuration.AIHUB_RUNTIME_DATABASE_SCOPE,
    ),
    expiresInSeconds: 900,
    clockSkewSeconds: 60,
  });
}

@Module({
  imports: [
    RuntimeConfigurationModule,
    PersistenceModule,
    SecretsModule,
    EmailDeliveryModule,
  ],
  controllers: [MfaController, WebSessionController, UserAccessTokenController],
  providers: [
    {
      provide: AUTH_POSTGRES_READINESS,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): AuthPostgresReadiness => ({
        check: (timeoutMs) => runtime.checkConnection(timeoutMs),
      }),
    },
    // One adapter per aggregate, all four over the shared runtime client: the
    // SQL and the transaction rules of one aggregate read in one file, so a
    // change to refresh-family revocation is no longer reviewed beside a change
    // to registration. The operations that cross aggregates still run one
    // transaction by writing the other tables through the shared statements.
    {
      provide: PostgresUserAccountRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_OUTBOX],
      useFactory: (
        runtime: PrismaClientHolder,
        emailOutbox: EmailOutboxPort,
      ): PostgresUserAccountRepository =>
        new PostgresUserAccountRepository(runtime.prisma, emailOutbox),
    },
    {
      provide: PostgresVerificationTokenRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_OUTBOX],
      useFactory: (
        runtime: PrismaClientHolder,
        emailOutbox: EmailOutboxPort,
      ): PostgresVerificationTokenRepository =>
        new PostgresVerificationTokenRepository(runtime.prisma, emailOutbox),
    },
    {
      provide: PostgresPasswordResetTokenRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_OUTBOX],
      useFactory: (
        runtime: PrismaClientHolder,
        emailOutbox: EmailOutboxPort,
      ): PostgresPasswordResetTokenRepository =>
        new PostgresPasswordResetTokenRepository(runtime.prisma, emailOutbox),
    },
    {
      provide: PostgresRefreshSessionRepository,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): PostgresRefreshSessionRepository =>
        new PostgresRefreshSessionRepository(runtime.prisma),
    },
    {
      provide: PostgresUserAccessTokenRevocationRepository,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (
        runtime: PrismaClientHolder,
      ): PostgresUserAccessTokenRevocationRepository =>
        new PostgresUserAccessTokenRevocationRepository(runtime.prisma),
    },
    {
      provide: AUTH_MFA_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_OUTBOX],
      useFactory: (
        runtime: PrismaClientHolder,
        emailOutbox: EmailOutboxPort,
      ): PostgresAuthMfaRepository =>
        new PostgresAuthMfaRepository(runtime.prisma, emailOutbox),
    },
    {
      provide: PostgresPasswordChangeRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_OUTBOX],
      useFactory: (
        runtime: PrismaClientHolder,
        emailOutbox: EmailOutboxPort,
      ): PostgresPasswordChangeRepository =>
        new PostgresPasswordChangeRepository(runtime.prisma, emailOutbox),
    },
    {
      provide: PASSWORD_CHANGE_REPOSITORY,
      useExisting: PostgresPasswordChangeRepository,
    },
    {
      provide: AUTH_MFA_CIPHER,
      inject: [appConfig.KEY],
      useFactory: (configuration: ConfigType<typeof appConfig>) =>
        createAuthMfaCipher({
          source: configuration.AIHUB_RUNTIME_SECRET_SOURCE,
          secretsFile: configuration.AIHUB_AUTH_MFA_SECRETS_FILE,
          values: getRuntimeSecretEnvironment(),
        }),
    },
    { provide: AUTH_MFA_ID, useFactory: () => prefixedIdGenerator('mfa_') },
    {
      provide: AUTH_MFA_SERVICE,
      useFactory: (...ports: ConstructorParameters<typeof AuthMfaService>) =>
        new AuthMfaService(...ports),
      inject: [
        AUTH_MFA_REPOSITORY,
        AUTH_MFA_CIPHER,
        USER_ACCOUNT_REPOSITORY,
        PASSWORD_HASHER,
        AUTH_RATE_LIMITER,
        AUTH_MFA_ID,
        AUTH_CLOCK,
      ],
    },
    {
      provide: USER_ACCOUNT_REPOSITORY,
      useExisting: PostgresUserAccountRepository,
    },
    {
      provide: VERIFICATION_TOKEN_REPOSITORY,
      useExisting: PostgresVerificationTokenRepository,
    },
    {
      provide: PASSWORD_RESET_TOKEN_REPOSITORY,
      useExisting: PostgresPasswordResetTokenRepository,
    },
    {
      provide: REFRESH_SESSION_REPOSITORY,
      useExisting: PostgresRefreshSessionRepository,
    },
    {
      provide: BloomFilterUserAccessTokenRevocationAdapter,
      inject: [
        PostgresUserAccessTokenRevocationRepository,
        RUNTIME_PRISMA_CLIENT,
        RUNTIME_CONNECTION_CONFIGURATION,
      ],
      useFactory: (
        underlying: PostgresUserAccessTokenRevocationRepository,
        runtime: PrismaClientHolder,
        connectionConfig: RuntimeConnectionConfigurationPort,
      ): BloomFilterUserAccessTokenRevocationAdapter => {
        const redisUrl = connectionConfig.redisUrl?.trim();
        let publisher: Redis | undefined;
        let subscriber: Redis | undefined;
        if (redisUrl !== undefined && redisUrl.length > 0) {
          publisher = createRedisClient(redisUrl, {
            commandTimeoutMs: 500,
          });
          subscriber = new Redis(redisUrl, {
            lazyConnect: true,
            enableOfflineQueue: true,
            maxRetriesPerRequest: null,
            connectTimeout: 1_000,
          });
          subscriber.on('error', () => undefined);
        }
        return new BloomFilterUserAccessTokenRevocationAdapter({
          underlying,
          checkStoreReady: (timeoutMs) => runtime.checkConnection(timeoutMs),
          redisPublisher: publisher,
          redisSubscriber: subscriber,
        });
      },
    },
    {
      provide: USER_ACCESS_TOKEN_REVOCATION_RECORD,
      useExisting: BloomFilterUserAccessTokenRevocationAdapter,
    },
    {
      // Web Sessions live in their own table beside the four refresh tables, so
      // they get their own adapter over the same pool: the pool and its shutdown
      // stay single without this module's data living in one giant class.
      provide: PostgresWebSessionRepository,
      inject: [RUNTIME_PRISMA_CLIENT],
      useFactory: (runtime: PrismaClientHolder): PostgresWebSessionRepository =>
        new PostgresWebSessionRepository(runtime.prisma),
    },
    {
      provide: WEB_SESSION_REPOSITORY,
      useExisting: PostgresWebSessionRepository,
    },
    {
      provide: WEB_SESSION_TOKEN_ISSUER,
      useFactory: (): WebSessionTokenIssuerPort =>
        opaqueTokenIssuer(WEB_SESSION_POLICY.prefix, WEB_SESSION_POLICY.ttlMs),
    },
    {
      provide: WEB_SESSION_ID,
      useFactory: () => prefixedIdGenerator(WEB_SESSION_POLICY.prefix),
    },
    {
      // The runtime provider owns the live value; absent local configuration fails closed.
      provide: WEB_SESSION_CLIENT_SECRET,
      inject: [RUNTIME_SECRET_PROVIDER],
      useFactory: (
        provider: RuntimeSecretProvider,
      ): WebSessionClientSecretPort => ({
        resolve: () => provider.getSnapshot().webSession?.clientSecret,
      }),
    },
    {
      provide: WEB_SESSION_SERVICE,
      useFactory: (
        ...ports: ConstructorParameters<typeof WebSessionService>
      ): WebSessionService => new WebSessionService(...ports),
      inject: [
        WEB_SESSION_REPOSITORY,
        WEB_SESSION_TOKEN_ISSUER,
        WEB_SESSION_ID,
        USER_ACCOUNT_REPOSITORY,
        PASSWORD_HASHER,
        AUTH_RATE_LIMITER,
        AUTH_CLOCK,
        VERIFICATION_TOKEN_REPOSITORY,
        VERIFICATION_TOKEN,
        USER_ACCESS_TOKEN_ISSUER,
        AUTH_MFA_SERVICE,
        AUTH_SECURITY_EVENT_RECORDER,
      ],
    },
    {
      provide: PASSWORD_HASHER,
      inject: [appConfig.KEY],
      useFactory: (
        configuration: ConfigType<typeof appConfig>,
      ): Argon2PasswordHasher =>
        new Argon2PasswordHasher(
          configuration.AIHUB_AUTH_ARGON2_MAX_CONCURRENCY,
        ),
    },
    {
      provide: PASSWORD_RESET_TOKEN,
      useFactory: (): PasswordResetTokenPort =>
        opaqueTokenIssuer(
          OPAQUE_TOKEN_BINDINGS.passwordReset.prefix,
          OPAQUE_TOKEN_BINDINGS.passwordReset.ttlMs,
        ),
    },
    { provide: REFRESH_TOKEN_ISSUER, useClass: CryptoRefreshToken },
    {
      provide: VERIFICATION_TOKEN,
      useFactory: (): VerificationTokenPort =>
        opaqueTokenIssuer(
          OPAQUE_TOKEN_BINDINGS.verification.prefix,
          OPAQUE_TOKEN_BINDINGS.verification.ttlMs,
        ),
    },
    {
      provide: AUTH_CLOCK,
      useFactory: (): AuthClock => ({ now: () => new Date() }),
    },
    {
      provide: AUTH_RATE_LIMITER,
      inject: [RUNTIME_CONNECTION_CONFIGURATION],
      useFactory: (
        configuration: RuntimeConnectionConfigurationPort,
      ): AuthRateLimiterPort =>
        new RedisAuthRateLimiter(configuration.redisUrl ?? ''),
    },
    {
      provide: USER_ACCESS_TOKEN_CRYPTO,
      useFactory: createUserAccessTokenCrypto,
      inject: [RUNTIME_SECRET_PROVIDER, appConfig.KEY],
    },
    {
      provide: USER_ACCESS_TOKEN_ISSUER,
      useExisting: USER_ACCESS_TOKEN_CRYPTO,
    },
    {
      provide: USER_ACCESS_TOKEN_VERIFIER,
      useExisting: USER_ACCESS_TOKEN_CRYPTO,
    },
    {
      provide: REVOKE_USER_ACCESS_TOKEN,
      useFactory: (
        ...ports: ConstructorParameters<typeof RevokeUserAccessTokenService>
      ): RevokeUserAccessTokenPort =>
        new RevokeUserAccessTokenService(...ports),
      inject: [USER_ACCESS_TOKEN_VERIFIER, USER_ACCESS_TOKEN_REVOCATION_RECORD],
    },
    {
      provide: AUTH_SECURITY_EVENT_RECORDER,
      useClass: AuthSecurityEventRecorder,
    },
    UserAccessJwtGuard,
    OptionalWebSessionClientGuard,
    WebSessionClientGuard,
  ],
  exports: [
    AUTH_POSTGRES_READINESS,
    EmailDeliveryModule,
    AUTH_RATE_LIMITER,
    USER_ACCOUNT_REPOSITORY,
    VERIFICATION_TOKEN_REPOSITORY,
    PASSWORD_RESET_TOKEN_REPOSITORY,
    USER_ACCESS_TOKEN_ISSUER,
    REFRESH_TOKEN_ISSUER,
    VERIFICATION_TOKEN,
    PASSWORD_RESET_TOKEN,
    AUTH_CLOCK,
    AUTH_SECURITY_EVENT_RECORDER,
    AUTH_MFA_SERVICE,
    PASSWORD_HASHER,
    PASSWORD_CHANGE_REPOSITORY,
    OptionalWebSessionClientGuard,
    REFRESH_SESSION_REPOSITORY,
    USER_ACCESS_TOKEN_VERIFIER,
    USER_ACCESS_TOKEN_REVOCATION_RECORD,
    WEB_SESSION_CLIENT_SECRET,
    UserAccessJwtGuard,
    WebSessionClientGuard,
  ],
})
export class AuthRuntimeModule {}
