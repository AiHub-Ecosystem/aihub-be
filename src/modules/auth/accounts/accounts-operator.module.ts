import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import type { PendingRegistrationRecordPort } from './application/expire-pending-registrations';
import { PostgresPendingRegistrationRecords } from './infrastructure/postgres-pending-registration-records';

/** Binds pending-registration persistence for the Operator surface. */
export function createOperatorPendingRegistrationRecords(
  prisma: PrismaClientHolder['prisma'],
): PendingRegistrationRecordPort {
  return new PostgresPendingRegistrationRecords(prisma);
}
