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
import { LocalAuthService } from './application/local-auth.service';
import { PASSWORD_HASHER } from './application/password-hasher.port';
import { VERIFICATION_TOKEN } from './application/verification-token.port';
import { Argon2PasswordHasher } from './infrastructure/argon2-password.hasher';
import { CryptoVerificationToken } from './infrastructure/crypto-verification-token';
import { createPostgresAuthClient } from './infrastructure/postgres-auth.client';
import { PostgresLocalAuthRepository } from './infrastructure/postgres-local-auth.repository';
import { RedisAuthRateLimiter } from './infrastructure/redis-auth-rate-limiter';
import { ResendEmailSender } from './infrastructure/resend-email.sender';
import { LocalAuthController } from './presentation/local-auth.controller';

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
    { provide: VERIFICATION_TOKEN, useClass: CryptoVerificationToken },
    {
      provide: EMAIL_SENDER,
      useFactory: (provider: RuntimeSecretProvider): EmailSenderPort => {
        const snapshot = provider.getSnapshot();
        return new ResendEmailSender(
          snapshot.resend,
          process.env.RESEND_FROM ?? '',
        );
      },
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    {
      provide: AUTH_RATE_LIMITER,
      useFactory: (): AuthRateLimiterPort =>
        new RedisAuthRateLimiter(process.env.REDIS_URL ?? ''),
    },
    { provide: LOCAL_AUTH_SERVICE, useClass: LocalAuthService },
  ],
  exports: [LOCAL_AUTH_SERVICE],
})
export class AuthModule {}
