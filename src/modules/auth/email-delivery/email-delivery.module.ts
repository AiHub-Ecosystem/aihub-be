import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { hashOpaqueToken } from '@/common/security/opaque-token-issuer';
import { appConfig } from '@/config/runtime-configuration';
import { RuntimeConfigurationModule } from '@/config/runtime-configuration.module';
import { PostgresEmailCredentialRepository } from '@/modules/auth/local-credentials/infrastructure/postgres-email-credential.repository';
import {
  EMAIL_DAILY_BUDGET_PRISMA_CLIENT,
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
import { EmailDeliveryPoller } from './application/email-delivery-poller';
import {
  EMAIL_DELIVERY_ID,
  EMAIL_DELIVERY_REQUEST_WRITER,
  EMAIL_NOTICE_RESOLVERS,
  EMAIL_PAYLOAD_CIPHER,
  type EmailDeliveryRequestWriterPort,
  type EmailNoticeResolvers,
  type EmailPayloadCipherPort,
} from './application/email-delivery-request.port';
import { normalizeCustomerWebBaseUrl } from './application/email-message.composer';
import { emailDailySendBudgetLimits } from './application/email-send-daily-budget.policy';
import {
  EMAIL_DAILY_SEND_BUDGET,
  type EmailDailySendBudgetPort,
} from './application/email-send-daily-budget.port';
import {
  EMAIL_SEND_RATE_LIMITER,
  type EmailSendRateLimiterPort,
} from './application/email-send-rate-limiter.port';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from './application/email-sender.port';
import {
  EMAIL_OUTBOX_POLL_INTERVAL_MS,
  EmailOutboxPollerScheduler,
  emailOutboxLeaseOwner,
  reportEmailProviderConfigurationFailure,
  reportTerminalEmailDeliveryFailure,
} from './infrastructure/email-outbox-poller.scheduler';
import { createEmailPayloadCipher } from './infrastructure/email-payload-cipher';
import { PostgresEmailDailySendBudget } from './infrastructure/postgres-email-daily-send-budget';
import { pruneExpiredAuthEmailRecipientLimits } from './infrastructure/postgres-email-delivery-request.repository';
import { PostgresEmailDeliveryRequestRepository } from './infrastructure/postgres-email-delivery-request.repository';
import { PostgresEmailDispatchStore } from './infrastructure/postgres-email-dispatch-store';
import { RedisEmailSendRateLimiter } from './infrastructure/redis-email-send-rate-limiter';
import { ResendEmailSender } from './infrastructure/resend-email.sender';

@Module({
  imports: [RuntimeConfigurationModule, PersistenceModule, SecretsModule],
  providers: [
    {
      provide: EMAIL_DELIVERY_ID,
      useFactory: () => prefixedIdGenerator('edr_'),
    },
    {
      provide: EMAIL_SENDER,
      useFactory: (
        provider: RuntimeSecretProvider,
        configuration: ConfigType<typeof appConfig>,
      ): EmailSenderPort =>
        new ResendEmailSender(
          provider.getSnapshot().resend,
          configuration.RESEND_FROM ?? '',
          fetch,
        ),
      inject: [RUNTIME_SECRET_PROVIDER, appConfig.KEY],
    },
    // Cross-aggregate mutations enqueue through this port in their own transaction.
    {
      provide: EMAIL_DELIVERY_REQUEST_WRITER,
      inject: [RUNTIME_SECRET_PROVIDER],
      useFactory: (
        provider: RuntimeSecretProvider,
      ): EmailDeliveryRequestWriterPort =>
        new PostgresEmailDeliveryRequestRepository(
          provider.getSnapshot().emailOutbox,
        ),
    },
    {
      provide: EMAIL_PAYLOAD_CIPHER,
      useFactory: (provider: RuntimeSecretProvider): EmailPayloadCipherPort =>
        createEmailPayloadCipher(provider.getSnapshot().emailOutbox),
      inject: [RUNTIME_SECRET_PROVIDER],
    },
    // Empty here; the module owning a notice's facts fills its slot (ADR-0120).
    {
      provide: EMAIL_NOTICE_RESOLVERS,
      useFactory: (): EmailNoticeResolvers => ({}),
    },
    {
      provide: EMAIL_SEND_RATE_LIMITER,
      inject: [RUNTIME_CONNECTION_CONFIGURATION, appConfig.KEY],
      useFactory: (
        connections: RuntimeConnectionConfigurationPort,
        configuration: ConfigType<typeof appConfig>,
      ): EmailSendRateLimiterPort =>
        new RedisEmailSendRateLimiter(
          connections.emailSendRateRedisUrl ?? '',
          configuration.AIHUB_EMAIL_SEND_RATE_LIMIT,
          configuration.AIHUB_EMAIL_SEND_RATE_DURATION_MS,
        ),
    },
    {
      provide: EMAIL_DAILY_SEND_BUDGET,
      inject: [EMAIL_DAILY_BUDGET_PRISMA_CLIENT, appConfig.KEY],
      useFactory: (
        database: PrismaClientHolder,
        configuration: ConfigType<typeof appConfig>,
      ): EmailDailySendBudgetPort =>
        new PostgresEmailDailySendBudget(
          () => database.pool,
          emailDailySendBudgetLimits(
            configuration.AIHUB_EMAIL_DAILY_SEND_BUDGET ?? 0,
          ),
        ),
    },
    {
      provide: EmailDeliveryPoller,
      useFactory: (
        runtime: PrismaClientHolder,
        cipher: EmailPayloadCipherPort,
        sender: EmailSenderPort,
        sendRateLimiter: EmailSendRateLimiterPort,
        dailySendBudget: EmailDailySendBudgetPort,
        configuration: ConfigType<typeof appConfig>,
        notices: EmailNoticeResolvers,
      ): EmailDeliveryPoller => {
        const isProduction =
          configuration.NODE_ENV === 'production' ||
          configuration.NODE_ENV === 'staging';
        const customerWebBaseUrl = normalizeCustomerWebBaseUrl(
          configuration.CUSTOMER_WEB_BASE_URL,
          isProduction,
          isProduction &&
            configuration.AIHUB_RUNTIME_DATABASE_SCOPE !== 'sandbox',
        );
        return new EmailDeliveryPoller(
          new PostgresEmailDispatchStore(runtime.prisma),
          new PostgresEmailCredentialRepository(runtime.prisma),
          cipher,
          sender,
          sendRateLimiter,
          (): Date => new Date(),
          { hash: hashOpaqueToken },
          {
            owner: emailOutboxLeaseOwner(),
            ...(customerWebBaseUrl === undefined ? {} : { customerWebBaseUrl }),
            onTerminalFailure: reportTerminalEmailDeliveryFailure,
            onProviderConfigurationFailure:
              reportEmailProviderConfigurationFailure,
            dailySendBudget,
            notices,
          },
        );
      },
      inject: [
        RUNTIME_PRISMA_CLIENT,
        EMAIL_PAYLOAD_CIPHER,
        EMAIL_SENDER,
        EMAIL_SEND_RATE_LIMITER,
        EMAIL_DAILY_SEND_BUDGET,
        appConfig.KEY,
        EMAIL_NOTICE_RESOLVERS,
      ],
    },
    {
      provide: EmailOutboxPollerScheduler,
      useFactory: (
        poller: EmailDeliveryPoller,
        runtime: PrismaClientHolder,
        configuration: ConfigType<typeof appConfig>,
        dailyBudget: EmailDailySendBudgetPort,
      ): EmailOutboxPollerScheduler => {
        const store = new PostgresEmailDispatchStore(runtime.prisma);
        return new EmailOutboxPollerScheduler(
          poller,
          EMAIL_OUTBOX_POLL_INTERVAL_MS,
          () => store.backlog({ now: new Date() }),
          configuration.NODE_ENV !== 'test',
          () =>
            pruneExpiredAuthEmailRecipientLimits(runtime.prisma, new Date()),
          () => store.cancellationTimestamps(),
          () => dailyBudget.usage(),
        );
      },
      inject: [
        EmailDeliveryPoller,
        RUNTIME_PRISMA_CLIENT,
        appConfig.KEY,
        EMAIL_DAILY_SEND_BUDGET,
      ],
    },
  ],
  exports: [
    EMAIL_DELIVERY_ID,
    EMAIL_DELIVERY_REQUEST_WRITER,
    EMAIL_NOTICE_RESOLVERS,
    EMAIL_PAYLOAD_CIPHER,
    EMAIL_SENDER,
  ],
})
export class EmailDeliveryModule {}
