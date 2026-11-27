import type { OrganizationTransactionClient } from '@/modules/persistence/persistence.module';

export { sandboxBudgetUnavailable } from '@/modules/gateway/application/sandbox-admission';
export {
  SANDBOX_DISPATCH_BUDGET,
  type SandboxAllowanceSnapshot,
  type SandboxDispatchBudgetPort,
} from '@/modules/gateway/application/sandbox-dispatch-budget.port';

export const RELEASE_SANDBOX_DISPATCH_RESERVATIONS = Symbol(
  'RELEASE_SANDBOX_DISPATCH_RESERVATIONS',
);

/** Releases reservations inside an existing Organization transaction. */
export type ReleaseSandboxDispatchReservationsPort = (
  transaction: OrganizationTransactionClient,
  organizationId: string,
  requestIds: string[],
  releasedAt: Date,
) => Promise<void>;
