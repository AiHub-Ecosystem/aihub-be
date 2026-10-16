import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import {
  observeDispatchDeadlineMsRemaining,
  recordDispatchCancelledByDeadline,
} from '@/common/observability/metrics';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
} from '@/modules/metering/public/dispatch-attempts';
import { requireTimeLeft } from './dispatch-deadline';
import type {
  DispatchResult,
  OperationDispatcherPort,
  RequestFor,
  ResponseFor,
} from './operation-dispatcher.port';
import type {
  OperationTransportPort,
  PreparedDispatch,
} from './operation-transport.port';
import type { SandboxAdmission } from './sandbox-admission';

/** What one dispatch has observed so far; the evidence the outcome is read from. */
interface DispatchRun {
  attemptId?: string;
  callStarted: boolean;
  callInFlight: boolean;
  responseStatus?: number;
  deadlineAbortedCall: boolean;
}

function dispatchEvidenceUnavailable(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    retryable: false,
    cause,
  });
}

function isErrorStatus(status: number | undefined): boolean {
  return status !== undefined && (status < 200 || status >= 300);
}

function classifyAttemptOutcome(
  responseStatus: number | undefined,
  notDispatched: boolean,
): DispatchAttemptOutcome {
  if (responseStatus !== undefined) {
    return 'response_received';
  }
  return notDispatched ? 'not_dispatched' : 'outcome_unknown';
}

/**
 * The dispatch policy around a transport: Sandbox admission, the attempt
 * record, the deadline, and the outcome classification. Everything that needs
 * a network lives behind `OperationTransportPort`.
 */
export class GuardedOperationDispatcher implements OperationDispatcherPort {
  constructor(
    private readonly transport: OperationTransportPort,
    private readonly attempts: DispatchAttemptRecordPort,
    private readonly sandbox: SandboxAdmission,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}

  async dispatch<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const prepared = await this.transport.prepare(operation, input, context);
    await this.sandbox.admit(context);

    const run: DispatchRun = {
      callStarted: false,
      callInFlight: false,
      deadlineAbortedCall: false,
    };
    try {
      return await this.attempt(prepared, operation, context, run);
    } catch (error) {
      await this.settle(error, operation, context, run);
      throw error;
    }
  }

  private async attempt<O extends OperationId>(
    prepared: PreparedDispatch<O>,
    operation: O,
    context: RequestContext,
    run: DispatchRun,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    requireTimeLeft(context);
    const organizationId = context.organizationId;
    if (organizationId === undefined) {
      throw dispatchEvidenceUnavailable(
        new Error('organization context is required'),
      );
    }
    try {
      run.attemptId = await this.attempts.beginAttempt({
        requestId: context.requestId,
        organizationId,
        operation,
        operationTimeoutMs: context.operationTimeoutMs,
      });
    } catch (error) {
      throw dispatchEvidenceUnavailable(error);
    }
    const remainingMs = requireTimeLeft(context);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(remainingMs),
    ]);
    observeDispatchDeadlineMsRemaining(operation, remainingMs);

    const result = await this.call(prepared, run, signal, remainingMs);
    await this.record(run.attemptId, 'response_received');
    return result;
  }

  private async call<O extends OperationId>(
    prepared: PreparedDispatch<O>,
    run: DispatchRun,
    signal: AbortSignal,
    deadlineMs: number,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const noteDeadlineAbort = (): void => {
      const reason = signal.reason as { readonly name?: unknown } | undefined;
      if (
        run.callInFlight &&
        !isErrorStatus(run.responseStatus) &&
        reason?.name === 'TimeoutError'
      ) {
        run.deadlineAbortedCall = true;
      }
    };
    signal.addEventListener('abort', noteDeadlineAbort, { once: true });
    run.callStarted = true;
    run.callInFlight = true;
    try {
      return await prepared.send({
        deadlineMs,
        signal,
        onResponseReceived: (statusCode) => {
          run.responseStatus = statusCode;
        },
      });
    } finally {
      run.callInFlight = false;
      signal.removeEventListener('abort', noteDeadlineAbort);
    }
  }

  private async settle<O extends OperationId>(
    error: unknown,
    operation: O,
    context: RequestContext,
    run: DispatchRun,
  ): Promise<void> {
    if (run.deadlineAbortedCall) {
      recordDispatchCancelledByDeadline(operation);
    }
    const notDispatched =
      !run.callStarted || this.transport.isUndelivered(error);
    if (run.attemptId !== undefined) {
      await this.record(
        run.attemptId,
        classifyAttemptOutcome(run.responseStatus, notDispatched),
      );
    }
    if (notDispatched) {
      await this.sandbox.release(context);
    }
  }

  private async record(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void> {
    try {
      await this.attempts.recordOutcome(attemptId, outcome);
    } catch {
      this.warn('Dispatch attempt outcome could not be recorded');
    }
  }
}
