import { createCliRuntimeSecretProvider } from './runtime-secret-provider';

export async function createOperatorNotificationClient(databaseUrl: string) {
  const [
    { createIdentityTransactionRunner },
    { createOperatorPrismaClient },
    { PostgresApiKeyNearExpiryNotices },
    { createEmailPayloadCipher },
    { PostgresEmailDeliveryRequestRepository },
    { EmailOutbox, EmailOutboxBackpressureGate },
    { prefixedIdGenerator },
    { PostgresEmailOutboxQueueAge },
    { PostgresEmailDispatchStore },
    { recordEmailOutboxBackpressureRefusal },
  ] = await Promise.all([
    import('@/modules/identity/shared/infrastructure/postgres-identity.client'),
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices'
    ),
    import('@/modules/auth/email-delivery/infrastructure/email-payload-cipher'),
    import(
      '@/modules/auth/email-delivery/infrastructure/postgres-email-delivery-request.repository'
    ),
    import('@/modules/auth/public/email-outbox'),
    import('@/common/ids/prefixed-id'),
    import(
      '@/modules/auth/email-delivery/infrastructure/postgres-email-outbox-queue-age'
    ),
    import(
      '@/modules/auth/email-delivery/infrastructure/postgres-email-dispatch-store'
    ),
    import('@/common/observability/metrics'),
  ]);
  const emailOutboxSecrets =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const holder = createOperatorPrismaClient('control-plane', databaseUrl);
  const dispatchStore = new PostgresEmailDispatchStore(holder.prisma);
  const emailOutbox = new EmailOutbox(
    new PostgresEmailDeliveryRequestRepository(emailOutboxSecrets),
    createEmailPayloadCipher(emailOutboxSecrets),
    prefixedIdGenerator('edr_'),
    new EmailOutboxBackpressureGate(
      new PostgresEmailOutboxQueueAge(dispatchStore),
      recordEmailOutboxBackpressureRefusal,
    ),
  );
  return Object.assign(
    new PostgresApiKeyNearExpiryNotices(
      createIdentityTransactionRunner(holder.prisma),
      emailOutbox,
    ),
    { close: () => holder.close() },
  );
}
