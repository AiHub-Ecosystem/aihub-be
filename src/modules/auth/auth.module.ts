import { Module } from '@nestjs/common';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import {
  OPAQUE_TOKEN_BINDINGS,
  hashOpaqueToken,
  opaqueTokenIssuer,
} from '@/common/security/opaque-token-issuer';
import { EmailDeliveryPoller } from '@/modules/auth/application/email-delivery-poller';
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
  EMAIL_DELIVERY_ID,
  EMAIL_DELIVERY_REQUEST_WRITER,
  EMAIL_PAYLOAD_CIPHER,
  type EmailDeliveryRequestWriterPort,
  type EmailPayloadCipherPort,
} from './application/email-delivery-request.port';
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
  EMAIL_OUTBOX_POLL_INTERVAL_MS,
  EmailOutboxPollerScheduler,
  emailOutboxLeaseOwner,
  reportTerminalEmailDeliveryFailure,
} from './infrastructure/email-outbox-poller.scheduler';
import { createEmailPayloadCipher } from './infrastructure/email-payload-cipher';
import {
  JoseUserAccessTokenService,
  USER_ACCESS_TOKEN_CRYPTO,
} from './infrastructure/jose-user-access-token.service';
import {
  POSTGRES_AUTH_CLIENT,
  type PostgresAuthClient,
  createPostgresAuthClient,
} from './infrastructure/postgres-auth.client';
import { PostgresEmailCredentialRepository } from './infrastructure/postgres-email-credential.repository';
import {
  PostgresEmailDeliveryRequestRepository,
  PostgresEmailDispatchStore,
} from './infrastructure/postgres-email-delivery-request.repository';
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
      provide: EMAIL_DELIVERY_ID,
      useFactory: () => prefixedIdGenerator('edr_'),
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
    // The outbox table is this module's (ADR-0074). Another module that commits
    // an Email Delivery Request with its own mutation writes it through this
    // port, inside that mutation's transaction.
    {
      provide: EMAIL_DELIVERY_REQUEST_WRITER,
      useFactory: (): EmailDeliveryRequestWriterPort =>
        new PostgresEmailDeliveryRequestRepository(),
    },
    {
      provide: EMAIL_PAYLOAD_CIPHER,
      useFactory: (provider: RuntimeSecretProvider): EmailPayloadCipherPort =>
        createEmailPayloadCipher(provider.getSnapshot().emailOutbox),
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    // The dispatch poller runs in every instance against its own database, so
    // it takes the same pool and key the writers used (ADR-0074). The token
    // hashing is the opaque issuer's, which is the one function all three
    // credential tables were written with.
    {
      provide: EmailDeliveryPoller,
      useFactory: (
        client: PostgresAuthClient,
        cipher: EmailPayloadCipherPort,
        sender: EmailSenderPort,
      ): EmailDeliveryPoller =>
        new EmailDeliveryPoller(
          new PostgresEmailDispatchStore(client),
          new PostgresEmailCredentialRepository(client),
          cipher,
          sender,
          (): Date => new Date(),
          { hash: hashOpaqueToken },
          {
            owner: emailOutboxLeaseOwner(),
            onTerminalFailure: reportTerminalEmailDeliveryFailure,
          },
        ),
      inject: [POSTGRES_AUTH_CLIENT, EMAIL_PAYLOAD_CIPHER, EMAIL_SENDER],
    },
    {
      provide: EmailOutboxPollerScheduler,
      useFactory: (
        poller: EmailDeliveryPoller,
        client: PostgresAuthClient,
      ): EmailOutboxPollerScheduler => {
        const store = new PostgresEmailDispatchStore(client);
        return new EmailOutboxPollerScheduler(
          poller,
          EMAIL_OUTBOX_POLL_INTERVAL_MS,
          () => store.backlog({ now: new Date() }),
        );
      },
      inject: [EmailDeliveryPoller, POSTGRES_AUTH_CLIENT],
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
      ],
    },
    UserAccessJwtGuard,
  ],
  exports: [
    EMAIL_SENDER,
    EMAIL_PAYLOAD_CIPHER,
    EMAIL_DELIVERY_REQUEST_WRITER,
    EMAIL_DELIVERY_ID,
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
