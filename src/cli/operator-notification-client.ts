import type { PostgresApiKeyNearExpiryNotices } from '@/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices';

import { createCliRuntimeSecretProvider } from './runtime-secret-provider';

import { operatorPostgresApplicationName } from './operator-postgres-application-name';

export async function createOperatorNotificationClient(
  databaseUrl: string,
): Promise<PostgresApiKeyNearExpiryNotices & { close(): Promise<void> }> {
  const [
    { createIdentityTransactionRunner },
    { createOperatorPrismaClient },
    { PostgresApiKeyNearExpiryNotices },
    { createOperatorEmailOutbox },
  ] = await Promise.all([
    import('@/modules/identity/shared/infrastructure/postgres-identity.client'),
    import('@/modules/persistence/infrastructure/prisma-client'),
    import(
      '@/modules/identity/notifications/infrastructure/postgres-api-key-near-expiry-notices'
    ),
    import('@/modules/auth/public/email-outbox'),
  ]);
  const emailOutboxSecrets =
    createCliRuntimeSecretProvider().getSnapshot().emailOutbox;
  const holder = createOperatorPrismaClient(
    'control-plane',
    databaseUrl,
    operatorPostgresApplicationName('control-plane'),
  );
  const emailOutbox = createOperatorEmailOutbox(
    holder.prisma,
    emailOutboxSecrets,
  );
  return Object.assign(
    new PostgresApiKeyNearExpiryNotices(
      createIdentityTransactionRunner(holder.prisma),
      emailOutbox,
    ),
    { close: () => holder.close() },
  );
}
