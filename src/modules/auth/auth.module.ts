import { Module } from '@nestjs/common';

import {
  OPAQUE_TOKEN_BINDINGS,
  opaqueTokenIssuer,
} from '@/common/security/opaque-token-issuer';
import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '@/modules/secrets/application/runtime-secret-provider.port';
import { SecretsModule } from '@/modules/secrets/secrets.module';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './application/auth-rate-limiter.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from './application/email-sender.port';
import { LOCAL_AUTH_SERVICE } from './application/local-auth-service.port';
import {
  AUTH_CLOCK,
  type LocalAuthServiceClock,
} from './application/local-auth.service';
import { LocalAuthService } from './application/local-auth.service';
import { PASSWORD_HASHER } from './application/password-hasher.port';
import { PASSWORD_RESET_TOKEN_REPOSITORY } from './application/password-reset-token-repository.port';
import {
  PASSWORD_RESET_TOKEN,
  type PasswordResetTokenPort,
} from './application/password-reset-token.port';
import { REFRESH_SESSION_REPOSITORY } from './application/refresh-session-repository.port';
import { REFRESH_TOKEN_ISSUER } from './application/refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
} from './application/user-access-token.port';
import { USER_ACCOUNT_REPOSITORY } from './application/user-account.port';
import { VERIFICATION_TOKEN_REPOSITORY } from './application/verification-token-repository.port';
import {
  VERIFICATION_TOKEN,
  type VerificationTokenPort,
} from './application/verification-token.port';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher';
import { CryptoRefreshToken } from './infrastructure/crypto-refresh-token';
import {
  JoseUserAccessTokenService,
  USER_ACCESS_TOKEN_CRYPTO,
} from './infrastructure/jose-user-access-token.service';
import {
  POSTGRES_AUTH_CLIENT,
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './infrastructure/postgres-auth.client';
import { PostgresLocalAuthRepository } from './infrastructure/postgres-local-auth.repository';
import { RedisAuthRateLimiter } from './infrastructure/redis-auth-rate-limiter';
import { ResendEmailSender } from './infrastructure/resend-email.sender';
import { LocalAuthController } from './presentation/local-auth.controller';
import { UserAccessJwtGuard } from './presentation/user-access-jwt.guard';

@Module({
  imports: [SecretsModule],
  controllers: [LocalAuthController],
  providers: [
    {
      provide: POSTGRES_AUTH_CLIENT,
      useFactory: (): PostgresAuthClient =>
        createPostgresAuthClient(process.env.DATABASE_URL ?? ''),
    },
    {
      provide: PostgresLocalAuthRepository,
      inject: [POSTGRES_AUTH_CLIENT],
      useFactory: (client: PostgresAuthClient): PostgresLocalAuthRepository =>
        new PostgresLocalAuthRepository(client),
    },
    // One Postgres adapter backs all four aggregate ports, so the pool and its
    // shutdown stay single.
    {
      provide: USER_ACCOUNT_REPOSITORY,
      useExisting: PostgresLocalAuthRepository,
    },
    {
      provide: VERIFICATION_TOKEN_REPOSITORY,
      useExisting: PostgresLocalAuthRepository,
    },
    {
      provide: PASSWORD_RESET_TOKEN_REPOSITORY,
      useExisting: PostgresLocalAuthRepository,
    },
    {
      provide: REFRESH_SESSION_REPOSITORY,
      useExisting: PostgresLocalAuthRepository,
    },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
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
      provide: EMAIL_SENDER,
      useFactory: (provider: RuntimeSecretProvider): EmailSenderPort => {
        const snapshot = provider.getSnapshot();
        const isProduction = process.env.NODE_ENV === 'production';
        return new ResendEmailSender(
          snapshot.resend,
          process.env.RESEND_FROM ?? '',
          fetch,
          process.env.CUSTOMER_WEB_BASE_URL,
          isProduction,
          isProduction &&
            process.env.AIHUB_RUNTIME_DATABASE_SCOPE !== 'sandbox',
        );
      },
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    {
      provide: AUTH_RATE_LIMITER,
      useFactory: (): AuthRateLimiterPort =>
        new RedisAuthRateLimiter(process.env.REDIS_URL ?? ''),
    },
    {
      provide: USER_ACCESS_TOKEN_CRYPTO,
      useFactory: (
        provider: RuntimeSecretProvider,
      ): JoseUserAccessTokenService => {
        const issuer = process.env.AIHUB_USER_ACCESS_ISSUER?.trim();
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
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    {
      provide: USER_ACCESS_TOKEN_ISSUER,
      useExisting: USER_ACCESS_TOKEN_CRYPTO,
    },
    {
      provide: USER_ACCESS_TOKEN_VERIFIER,
      useExisting: USER_ACCESS_TOKEN_CRYPTO,
    },
    { provide: LOCAL_AUTH_SERVICE, useClass: LocalAuthService },
    UserAccessJwtGuard,
  ],
  exports: [
    EMAIL_SENDER,
    AUTH_RATE_LIMITER,
    USER_ACCOUNT_REPOSITORY,
    VERIFICATION_TOKEN_REPOSITORY,
    PASSWORD_RESET_TOKEN_REPOSITORY,
    REFRESH_SESSION_REPOSITORY,
    LOCAL_AUTH_SERVICE,
    USER_ACCESS_TOKEN_VERIFIER,
    UserAccessJwtGuard,
  ],
})
export class AuthModule {}
