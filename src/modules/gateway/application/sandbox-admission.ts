import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import { requireTimeLeft } from './dispatch-deadline';
import { quotaExceededError } from './quota-period';
import type { SandboxDispatchBudgetPort } from './sandbox-dispatch-budget.port';

function sandboxBudgetUnavailable(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox dispatch admission is unavailable',
    retryable: true,
  });
}

/**
 * Sandbox admission: reserves the Organization's dispatch allowance before a
 * downstream call and gives it back when the call provably never left. A
 * production request passes through untouched.
 */
export class SandboxAdmission {
  constructor(
    private readonly budget: SandboxDispatchBudgetPort | undefined,
    private readonly warn: (message: string) => void,
  ) {}

  async admit(context: RequestContext): Promise<void> {
    if (context.environment !== 'sandbox') {
      return;
    }
    requireTimeLeft(context);
    const organizationId = context.organizationId;
    if (this.budget === undefined || organizationId === undefined) {
      throw sandboxBudgetUnavailable();
    }
    let admitted: boolean;
    try {
      // The Organization's allowance is resolved inside the reserving
      // transaction, so it cannot be read here and passed in as a number that
      // an operator's override has already overtaken.
      admitted = await this.budget.reserve({
        organizationId,
        requestId: context.requestId,
      });
    } catch {
      throw sandboxBudgetUnavailable();
    }
    try {
      requireTimeLeft(context);
    } catch (error) {
      if (admitted) {
        await this.release(context);
      }
      throw error;
    }
    if (!admitted) {
      throw quotaExceededError(new Date());
    }
  }

  async release(context: RequestContext): Promise<void> {
    if (context.environment !== 'sandbox') {
      return;
    }
    await this.budget?.release(context.requestId).catch(() => {
      this.warn(
        'Sandbox dispatch reservation could not be released after a pre-dispatch failure',
      );
    });
  }
}
