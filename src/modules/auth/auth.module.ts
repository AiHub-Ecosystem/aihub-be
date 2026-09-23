import { Module } from '@nestjs/common';

import {
  RUNTIME_SECRET_PROVIDER,
  type RuntimeSecretProvider,
} from '../secrets/application/runtime-secret-provider.port';
import { SecretsModule } from '../secrets/secrets.module';
import {
  AUTH_RATE_LIMITER,
  type AuthRateLimiterPort,
} from './application/auth-rate-limiter.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from './application/email-sender.port';
import {
  LOCAL_AUTH_REPOSITORY,
  type LocalAuthRepositoryPort,
} from './application/local-auth-repository.port';
import { LOCAL_AUTH_SERVICE } from './application/local-auth-service.port';
import {
  AUTH_CLOCK,
  type LocalAuthServiceClock,
} from './application/local-auth.service';
import { LocalAuthService } from './application/local-auth.service';
import { PASSWORD_HASHER } from './application/password-hasher.port';
import { PASSWORD_RESET_TOKEN } from './application/password-reset-token.port';
import { REFRESH_TOKEN_ISSUER } from './application/refresh-token.port';
import {
  USER_ACCESS_TOKEN_ISSUER,
  USER_ACCESS_TOKEN_VERIFIER,
} from './application/user-access-token.port';
import { VERIFICATION_TOKEN } from './application/verification-token.port';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher';
import { CryptoPasswordResetToken } from './infrastructure/crypto-password-reset-token';
import { CryptoRefreshToken } from './infrastructure/crypto-refresh-token';
import { CryptoVerificationToken } from './infrastructure/crypto-verification-token';
import {
  JoseUserAccessTokenService,
  USER_ACCESS_TOKEN_CRYPTO,
} from './infrastructure/jose-user-access-token.service';
import { createPostgresAuthClient } from './infrastructure/postgres-auth.client';
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
      provide: LOCAL_AUTH_REPOSITORY,
      useFactory: (): LocalAuthRepositoryPort =>
        new PostgresLocalAuthRepository(
          createPostgresAuthClient(process.env.DATABASE_URL ?? ''),
        ),
    },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: PASSWORD_RESET_TOKEN, useClass: CryptoPasswordResetToken },
    { provide: REFRESH_TOKEN_ISSUER, useClass: CryptoRefreshToken },
    { provide: VERIFICATION_TOKEN, useClass: CryptoVerificationToken },
    {
      provide: AUTH_CLOCK,
      useFactory: (): LocalAuthServiceClock => ({ now: () => new Date() }),
    },
    {
      provide: EMAIL_SENDER,
      useFactory: (provider: RuntimeSecretProvider): EmailSenderPort => {
        const snapshot = provider.getSnapshot();
        return new ResendEmailSender(
          snapshot.resend,
          process.env.RESEND_FROM ?? '',
          fetch,
          process.env.CUSTOMER_WEB_BASE_URL,
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
    LOCAL_AUTH_REPOSITORY,
    LOCAL_AUTH_SERVICE,
    USER_ACCESS_TOKEN_VERIFIER,
    UserAccessJwtGuard,
  ],
})
export class AuthModule {}
