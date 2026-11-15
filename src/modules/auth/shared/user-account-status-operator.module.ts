import type { PrismaClientHolder } from '@/modules/persistence/persistence.module';

import type { UserAccountStatusPort } from './application/user-account-status.port';
import { PostgresUserAccountStatusRepository } from './infrastructure/postgres-user-account-status.repository';

/** Binds user-account status persistence for Operator commands. */
export function createOperatorUserAccountStatusRepository(
  prisma: PrismaClientHolder['prisma'],
): UserAccountStatusPort {
  return new PostgresUserAccountStatusRepository(prisma);
}
