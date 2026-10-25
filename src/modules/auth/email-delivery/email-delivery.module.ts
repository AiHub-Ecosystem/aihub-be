import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';

import { isShuttingDown } from '@/common/http/background-work-drain';
import { prefixedIdGenerator } from '@/common/ids/prefixed-id';
import { recordEmailOutboxBackpressureRefusal } from '@/common/observability/metrics';
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
import { EmailOutboxBackpressureGate } from './application/email-outbox-backpressure.gate';
import { ADMIT_EMAIL_REQUEST } from './application/email-outbox-backpressure.port';
import {
  EMAIL_PROVIDER_OUTAGE_CIRCUIT,
  type EmailProviderOutageCircuitPort,
} from './application/email-provider-outage-circuit.port';
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
  assertRetainedKeyVersionsCoverLiveWindows,
  pruneExpiredAuthEmailRecipientLimits,
} from './infrastructure/auth-email-recipient-limit';
import { missingQueuedEmailPayloadKeyVersions } from './infrastructure/email-outbox-key-retention';
import {
  EMAIL_OUTBOX_POLL_INTERVAL_MS,
  EmailOutboxPollerScheduler,
  emailOutboxLeaseOwner,
  reportEmailProviderConfigurationFailure,
  reportTerminalEmailDeliveryFailure,
} from './infrastructure/email-outbox-poller.scheduler';
import { createEmailPayloadCipher } from './infrastructure/email-payload-cipher';
import { PostgresEmailDailySendBudget } from './infrastructure/postgres-email-daily-send-budget';
import { PostgresEmailDeliveryRequestRepository } from './infrastructure/postgres-email-delivery-request.repository';
import { PostgresEmailDispatchStore } from './infrastructure/postgres-email-dispatch-store';
import { PostgresEmailOutboxQueueAge } from './infrastructure/postgres-email-outbox-queue-age';
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
      provide: ADMIT_EMAIL_REQUEST,
      useFactory: (runtime: PrismaClientHolder): EmailOutboxBackpressureGate =>
        new EmailOutboxBackpressureGate(
          new PostgresEmailOutboxQueueAge(
            new PostgresEmailDispatchStore(runtime.prisma),
          ),
          recordEmailOutboxBackpressureRefusal,
        ),
      inject: [RUNTIME_PRISMA_CLIENT],
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
      provide: EMAIL_PROVIDER_OUTAGE_CIRCUIT,
      useExisting: EMAIL_SEND_RATE_LIMITER,
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
        providerOutageCircuit: EmailProviderOutageCircuitPort,
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
          providerOutageCircuit,
          (): Date => new Date(),
          { hash: hashOpaqueToken },
          {
            owner: emailOutboxLeaseOwner(),
            ...(customerWebBaseUrl === undefined ? {} : { customerWebBaseUrl }),
            shouldStop: isShuttingDown,
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
        EMAIL_PROVIDER_OUTAGE_CIRCUIT,
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
        providerOutageCircuit: EmailProviderOutageCircuitPort,
        secrets: RuntimeSecretProvider,
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
          () => providerOutageCircuit.readOutageDurationMs(),
          () =>
            assertRetainedKeyVersionsCoverLiveWindows(
              runtime.prisma,
              secrets.getSnapshot().emailOutbox,
              new Date(),
            ),
          () =>
            missingQueuedEmailPayloadKeyVersions(
              runtime.prisma,
              secrets.getSnapshot().emailOutbox,
            ),
        );
      },
      inject: [
        EmailDeliveryPoller,
        RUNTIME_PRISMA_CLIENT,
        appConfig.KEY,
        EMAIL_DAILY_SEND_BUDGET,
        EMAIL_PROVIDER_OUTAGE_CIRCUIT,
        RUNTIME_SECRET_PROVIDER,
      ],
    },
  ],
  exports: [
    EMAIL_DELIVERY_ID,
    ADMIT_EMAIL_REQUEST,
    EMAIL_DELIVERY_REQUEST_WRITER,
    EMAIL_NOTICE_RESOLVERS,
    EMAIL_PAYLOAD_CIPHER,
    EMAIL_SENDER,
  ],
})
export class EmailDeliveryModule {}
