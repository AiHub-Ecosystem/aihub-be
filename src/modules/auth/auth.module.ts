import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
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
  EMAIL_DELIVERY_ID,
  EMAIL_DELIVERY_REQUEST_WRITER,
  EMAIL_PAYLOAD_CIPHER,
  type EmailDeliveryRequestWriterPort,
} from './email-delivery/application/email-delivery-request.port';
import { ADMIT_EMAIL_REQUEST } from './email-delivery/application/email-outbox-backpressure.port';
import { EmailDeliveryModule } from './email-delivery/email-delivery.module';
import { PostgresEmailDeliveryRequestRepository } from './email-delivery/infrastructure/postgres-email-delivery-request.repository';
import { LOCAL_AUTH_SERVICE } from './local-credentials/application/local-auth-service.port';
import {
  AUTH_CLOCK,
  type LocalAuthServiceClock,
} from './local-credentials/application/local-auth.service';
import { LocalAuthService } from './local-credentials/application/local-auth.service';
import { PASSWORD_HASHER } from './local-credentials/application/password-hasher.port';
import { Argon2PasswordHasher } from './local-credentials/infrastructure/argon2-password.hasher';
import {
  AUTH_MFA_CIPHER,
  AUTH_MFA_ID,
  AUTH_MFA_REPOSITORY,
  AUTH_MFA_SERVICE,
} from './mfa/application/auth-mfa-repository.port';
import { AuthMfaService } from './mfa/application/auth-mfa.service';
import { createAuthMfaCipher } from './mfa/infrastructure/auth-mfa-secret.cipher';
import { PostgresAuthMfaRepository } from './mfa/infrastructure/postgres-auth-mfa.repository';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from './password-reset/application/password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from './password-reset/application/password-reset-token.port';
import { PostgresPasswordResetTokenRepository } from './password-reset/infrastructure/postgres-password-reset-token.repository';
import { LocalAuthController } from './presentation/local-auth.controller';
import { UserAccessJwtGuard } from './presentation/user-access-jwt.guard';
import {
  OptionalWebSessionClientGuard,
  WebSessionClientGuard,
} from './presentation/web-session-client.guard';
import { WebSessionController } from './presentation/web-session.controller';
import {
  AUTH_POSTGRES_READINESS,
  type AuthPostgresReadiness,
} from './public/postgres-readiness';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './rate-limit/application/auth-rate-limiter.port';
import { RedisAuthRateLimiter } from './rate-limit/infrastructure/redis-auth-rate-limiter';
import { VERIFICATION_TOKEN_REPOSITORY } from './verification/application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from './verification/application/verification-token.port';
import { PostgresVerificationTokenRepository } from './verification/infrastructure/postgres-verification-token.repository';
import { REFRESH_SESSION_REPOSITORY } from './web-sessions/application/refresh-session-repository.port';
import { REFRESH_TOKEN_ISSUER } from './web-sessions/application/refresh-token.port';
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

/** Whether a new verification token needs the registration password (ADR-0123). */
const EMAIL_VERIFICATION_REQUIRES_PASSWORD = Symbol(
  'EMAIL_VERIFICATION_REQUIRES_PASSWORD',
);

@Module({
  imports: [
    RuntimeConfigurationModule,
    PersistenceModule,
    SecretsModule,
    EmailDeliveryModule,
  ],
  controllers: [LocalAuthController, WebSessionController],
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
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_DELIVERY_REQUEST_WRITER],
      useFactory: (
        runtime: PrismaClientHolder,
        emailRequests: EmailDeliveryRequestWriterPort,
      ): PostgresUserAccountRepository =>
        new PostgresUserAccountRepository(runtime.prisma, emailRequests),
    },
    {
      provide: PostgresVerificationTokenRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_DELIVERY_REQUEST_WRITER],
      useFactory: (
        runtime: PrismaClientHolder,
        emailRequests: EmailDeliveryRequestWriterPort,
      ): PostgresVerificationTokenRepository =>
        new PostgresVerificationTokenRepository(runtime.prisma, emailRequests),
    },
    {
      provide: PostgresPasswordResetTokenRepository,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_DELIVERY_REQUEST_WRITER],
      useFactory: (
        runtime: PrismaClientHolder,
        emailRequests: EmailDeliveryRequestWriterPort,
      ): PostgresPasswordResetTokenRepository =>
        new PostgresPasswordResetTokenRepository(runtime.prisma, emailRequests),
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
      provide: AUTH_MFA_REPOSITORY,
      inject: [RUNTIME_PRISMA_CLIENT, EMAIL_DELIVERY_REQUEST_WRITER],
      useFactory: (
        runtime: PrismaClientHolder,
        emailRequests: PostgresEmailDeliveryRequestRepository,
      ): PostgresAuthMfaRepository =>
        new PostgresAuthMfaRepository(runtime.prisma, emailRequests),
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
        EMAIL_PAYLOAD_CIPHER,
        EMAIL_DELIVERY_ID,
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
      useFactory: (): LocalAuthServiceClock => ({ now: () => new Date() }),
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
      useFactory: (
        provider: RuntimeSecretProvider,
        configuration: ConfigType<typeof appConfig>,
      ): JoseUserAccessTokenService => {
        const issuer = configuration.AIHUB_USER_ACCESS_ISSUER?.trim();
        if (issuer === undefined || issuer.length === 0) {
          throw new Error('AIHUB_USER_ACCESS_ISSUER is required');
        }
        const runtime = provider.getSnapshot().userAccessJwt;
        return new JoseUserAccessTokenService({
          privateKeyPem: runtime.privateKeyPem,
          keyId: runtime.keyId,
          issuer,
          audience: 'aihub-user-api',
          expiresInSeconds: 900,
          clockSkewSeconds: 60,
        });
      },
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
      provide: EMAIL_VERIFICATION_REQUIRES_PASSWORD,
      inject: [appConfig.KEY],
      useFactory: (configuration: ConfigType<typeof appConfig>): boolean =>
        configuration.AIHUB_EMAIL_VERIFICATION_REQUIRES_PASSWORD,
    },
    {
      provide: LOCAL_AUTH_SERVICE,
      useFactory: (
        ...ports: ConstructorParameters<typeof LocalAuthService>
      ): LocalAuthService => new LocalAuthService(...ports),
      inject: [
        USER_ACCOUNT_REPOSITORY,
        VERIFICATION_TOKEN_REPOSITORY,
        PASSWORD_RESET_TOKEN_REPOSITORY,
        REFRESH_SESSION_REPOSITORY,
        PASSWORD_HASHER,
        VERIFICATION_TOKEN,
        PASSWORD_RESET_TOKEN,
        EMAIL_PAYLOAD_CIPHER,
        AUTH_RATE_LIMITER,
        USER_ACCESS_TOKEN_ISSUER,
        REFRESH_TOKEN_ISSUER,
        AUTH_CLOCK,
        EMAIL_DELIVERY_ID,
        AUTH_MFA_SERVICE,
        ADMIT_EMAIL_REQUEST,
        EMAIL_VERIFICATION_REQUIRES_PASSWORD,
      ],
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
    REFRESH_SESSION_REPOSITORY,
    LOCAL_AUTH_SERVICE,
    USER_ACCESS_TOKEN_VERIFIER,
    WEB_SESSION_CLIENT_SECRET,
    UserAccessJwtGuard,
    WebSessionClientGuard,
  ],
})
export class AuthModule {}
