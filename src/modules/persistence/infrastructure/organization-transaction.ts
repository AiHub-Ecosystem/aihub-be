import { internalError } from '@/common/errors/app-error';
import { type Prisma, type PrismaClient } from '@prisma-client/client';

import { CONTROL_PLANE_TRANSACTION_OPTIONS } from '@/modules/persistence/public/prisma-transaction-options';
import { runGuardedTransaction } from './prisma-raw';

/**
 * The one transaction seam for Organization-owned persistence (#785, ADR-0109).
 *
 * Request-serving code never decides which tenant a query sees from a global,
 * from the connection, or from the database session: it passes the Organization
 * explicitly and this helper opens the transaction that carries it. Query
 * predicates stay in the repositories; the session setting is a backstop for
 * the RLS slice that follows, not a replacement for those predicates.
 *
 * Callers choose the client (write or read) at the module boundary. Cross-tenant
 * work - migrations, sweeps, Operator commands - never calls this helper.
 */
const ORGANIZATION_SETTING = 'aihub.organization_id';
const SET_ORGANIZATION_SQL = 'SELECT set_config($1, $2, true)';

export type OrganizationTransactionClient = Prisma.TransactionClient;

class OrganizationTransactionExpiredError extends Error {
  constructor() {
    super('Organization transaction is no longer active');
    this.name = 'OrganizationTransactionExpiredError';
  }
}

export function organizationTransaction<T>(
  client: PrismaClient,
  organizationId: string,
  callback: (transaction: OrganizationTransactionClient) => Promise<T>,
  options: {
    readonly maxWait: number;
    readonly timeout: number;
  } = CONTROL_PLANE_TRANSACTION_OPTIONS,
): Promise<T> {
  if (organizationId.trim().length === 0) {
    throw internalError(
      'Organization identity is required for a scoped transaction',
    );
  }

  return client.$transaction(
    (transaction) =>
      runGuardedTransaction(
        transaction,
        async (guarded) => {
          // arch-check: shared SQL wrapper binds values separately
          await guarded.$queryRawUnsafe(
            SET_ORGANIZATION_SQL,
            ORGANIZATION_SETTING,
            organizationId,
          );
          return callback(guarded);
        },
        { expired: () => new OrganizationTransactionExpiredError() },
      ),
    options,
  );
}
