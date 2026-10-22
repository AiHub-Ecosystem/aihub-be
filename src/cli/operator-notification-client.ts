import { createCliRuntimeSecretProvider } from './runtime-secret-provider';

export async function createOperatorNotificationClient(databaseUrl: string) {
  const [
    { createIdentityTransactionRunner },
    { createOperatorPrismaClient },
    { PostgresApiKeyNearExpiryNotices },
    { createEmailPayloadCipher },
    { PostgresEmailDeliveryRequestRepository },
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
  ]);
  const emailOutbox =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const holder = createOperatorPrismaClient('control-plane', databaseUrl);
  return Object.assign(
    new PostgresApiKeyNearExpiryNotices(
      createIdentityTransactionRunner(holder.prisma),
      createEmailPayloadCipher(emailOutbox),
      new PostgresEmailDeliveryRequestRepository(emailOutbox),
    ),
    { close: () => holder.close() },
  );
}
