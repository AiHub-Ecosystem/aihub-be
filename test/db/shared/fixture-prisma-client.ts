import { internalError } from '@/common/errors/app-error';
import { createPrismaClient } from '@/modules/persistence/persistence.module';
import type { PrismaClient } from '@prisma-client/client';

/**
 * Test-only: a client with a pool of its own for the unchanged database-lane
 * specs, which open their own connection rather than receive the shared one.
 * No production module constructs it (ADR-0088, "Test-only compatibility
 * exceptions").
 */
export function createFixturePrismaClient(
  databaseUrl: string,
  unavailableMessage = 'DATABASE_URL is missing',
  applicationName?: string,
): PrismaClient & { close(): Promise<void> } {
  if (databaseUrl.trim().length === 0) {
    throw internalError(unavailableMessage);
  }

  const holder = createPrismaClient(
    'integration-test',
    databaseUrl,
    applicationName === undefined ? {} : { applicationName },
  );
  return Object.assign(holder.prisma, { close: () => holder.close() });
}
