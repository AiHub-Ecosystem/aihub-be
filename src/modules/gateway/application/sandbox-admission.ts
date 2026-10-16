import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import { requireTimeLeft } from './dispatch-deadline';
import { quotaExceededError } from './quota-period';
import type { SandboxDispatchBudgetPort } from './sandbox-dispatch-budget.port';

/** What an admitted request holds until its call is known to have left. */
export interface SandboxReservation {
  /** Gives the allowance back; never throws, a failure is only logged. */
  release(): Promise<void>;
}

const NO_RESERVATION: SandboxReservation = {
  release: async () => undefined,
};

function sandboxBudgetUnavailable(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox dispatch admission is unavailable',
    retryable: true,
  });
}

/**
 * Sandbox admission: reserves the Organization's dispatch allowance before a
 * downstream call. A production request passes through holding nothing.
 */
export class SandboxAdmission {
  constructor(
    private readonly budget: SandboxDispatchBudgetPort | undefined,
    private readonly warn: (message: string) => void,
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
    } catch {
      throw sandboxBudgetUnavailable();
    }
    const reservation: SandboxReservation = {
      release: () => this.release(budget, context.requestId),
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
      throw quotaExceededError(new Date());
    }
    return reservation;
  }

  private async release(
    budget: SandboxDispatchBudgetPort,
    requestId: string,
  ): Promise<void> {
    await budget.release(requestId).catch(() => {
      this.warn(
        'Sandbox dispatch reservation could not be released after a pre-dispatch failure',
      );
    });
  }
}
