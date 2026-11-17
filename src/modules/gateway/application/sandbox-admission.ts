import { AppError } from '@/common/errors/app-error';
import { recordRejected } from '@/common/observability/rejected-metric';
import {
  databaseUnavailableError,
  isPostgresUnavailable,
} from '@/common/postgres/postgres-unavailable-error';
import type { RequestContext } from '@/common/request-context/request-context';
import { quotaExceededError } from '@/modules/metering/public/quota-counter';
import { requireTimeLeft } from './dispatch/dispatch-deadline';
import type { SandboxDispatchBudgetPort } from './sandbox-dispatch-budget.port';

/** What an admitted request holds until its call is known to have left. */
export interface SandboxReservation {
  /** Gives the allowance back; never throws, a failure is only logged. */
  release(): Promise<void>;
}

const NO_RESERVATION: SandboxReservation = {
  release: async () => undefined,
};

/**
 * The reservation store is a control-plane database. An outage answers the
 * shared retryable 503 (#373); anything else is a fault on our side.
 */
export function sandboxBudgetUnavailable(cause?: unknown): AppError {
  if (isPostgresUnavailable(cause)) {
    return databaseUnavailableError(
      cause,
      'Sandbox dispatch admission is unavailable',
    );
  }
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox dispatch admission is unavailable',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Sandbox admission: reserves the Organization's dispatch allowance before a
 * downstream call. A production request passes through holding nothing.
 */
export class SandboxAdmission {
  constructor(
    private readonly budget: SandboxDispatchBudgetPort | undefined,
    private readonly warn: (event: string) => void,
  ) {}

  async admit(context: RequestContext): Promise<SandboxReservation> {
    if (context.environment !== 'sandbox') {
      return NO_RESERVATION;
    }
    requireTimeLeft(context);
    const { budget } = this;
    const organizationId = context.organizationId;
    if (budget === undefined || organizationId === undefined) {
      throw sandboxBudgetUnavailable();
    }
    let admitted: boolean;
    try {
      // The Organization's allowance is resolved inside the reserving
      // transaction, so it cannot be read here and passed in as a number that
      // an operator's override has already overtaken.
      admitted = await budget.reserve({
        organizationId,
        requestId: context.requestId,
      });
    } catch (error) {
      throw sandboxBudgetUnavailable(error);
    }
    const reservation: SandboxReservation = {
      release: () => this.release(budget, organizationId, context.requestId),
    };
    try {
      requireTimeLeft(context);
    } catch (error) {
      if (admitted) {
        await reservation.release();
      }
      throw error;
    }
    if (!admitted) {
      recordRejected('quota');
      throw quotaExceededError(new Date(), organizationId);
    }
    return reservation;
  }

  private async release(
    budget: SandboxDispatchBudgetPort,
    organizationId: string,
    requestId: string,
  ): Promise<void> {
    await budget.release(organizationId, requestId).catch(() => {
      this.warn('sandbox_dispatch_reservation_release_failed');
    });
  }
}
