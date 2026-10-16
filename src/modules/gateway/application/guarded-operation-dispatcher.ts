import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  DispatchAttemptOutcome,
  DispatchAttemptRecordPort,
} from '@/modules/metering/public/dispatch-attempts';
import { requireTimeLeft } from './dispatch-deadline';
import type { DispatchObserverPort } from './dispatch-observer.port';
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
import type { SandboxAdmission, SandboxReservation } from './sandbox-admission';

/**
 * One dispatch and what it has observed so far: the evidence its outcome is
 * read from.
 */
interface DispatchRun {
  readonly operation: OperationId;
  readonly context: RequestContext;
  readonly reservation: SandboxReservation;
  attemptId?: string;
  callStarted: boolean;
  callInFlight: boolean;
  responseStatus?: number;
  deadlineAbortedCall: boolean;
}

/** The time the one downstream call may take, and how to cancel it. */
interface CallWindow {
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
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
    private readonly observer: DispatchObserverPort,
    private readonly warn: (message: string) => void,
  ) {}

  async dispatch<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const prepared = await this.transport.prepare(operation, input, context);
    const reservation = await this.sandbox.admit(context);

    const run: DispatchRun = {
      operation,
      context,
      reservation,
      callStarted: false,
      callInFlight: false,
      deadlineAbortedCall: false,
    };
    try {
      return await this.attempt(prepared, run);
    } catch (error) {
      await this.settle(error, run);
      throw error;
    }
  }

  private async attempt<O extends OperationId>(
    prepared: PreparedDispatch<O>,
    run: DispatchRun,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const { context, operation } = run;
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
    this.observer.deadlineMsRemaining(operation, remainingMs);

    const result = await this.call(prepared, run, {
      signal,
      deadlineMs: remainingMs,
    });
    await this.record(run.attemptId, 'response_received');
    return result;
  }

  private async call<O extends OperationId>(
    prepared: PreparedDispatch<O>,
    run: DispatchRun,
    window: CallWindow,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const { signal } = window;
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
        ...window,
        onResponseReceived: (statusCode) => {
          run.responseStatus = statusCode;
        },
      });
    } finally {
      run.callInFlight = false;
      signal.removeEventListener('abort', noteDeadlineAbort);
    }
  }

  private async settle(error: unknown, run: DispatchRun): Promise<void> {
    if (run.deadlineAbortedCall) {
      this.observer.cancelledByDeadline(run.operation);
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
      await run.reservation.release();
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
