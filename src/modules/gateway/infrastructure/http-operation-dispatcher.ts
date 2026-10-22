import { Logger } from '@nestjs/common';

import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { ErrorCode } from '@/common/errors/error-code';
import { recordDownstreamRetryEvent } from '@/common/observability/metrics';
import type { RequestContext } from '@/common/request-context/request-context';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';
import type { DownstreamRetryBudgetPort } from '@/modules/gateway/application/downstream-retry-budget.port';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/operation-dispatcher.port';
import type {
  OperationTransportPort,
  PreparedDispatch,
  TransportCall,
} from '@/modules/gateway/application/operation-transport.port';
import { extractDownstreamTelemetry } from '@/modules/metering/public/telemetry';
import { DownstreamCircuitBreakers } from './downstream-circuit-breakers';
import {
  type DownstreamHttpClient,
  isDefinitelyNotDispatched,
} from './downstream-http.client';

function mapDownstreamStatus(status: number, retryAfterMs?: number): AppError {
  if (status === 429) {
    return new AppError({
      code: 'AI_SERVICE_THROTTLED',
      message: 'AI service is temporarily throttled',
      retryable: true,
    });
  }

  return new AppError({
    code: 'AI_SERVICE_ERROR',
    message: 'AI service returned an error',
    retryable: status >= 500,
    downstreamStatus: status,
    ...(status === 503 && retryAfterMs !== undefined ? { retryAfterMs } : {}),
    cause: new Error(`downstream status ${status}`),
  });
}

function retryAfterMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) &&
      seconds * 1000 <= Number.MAX_SAFE_INTEGER
      ? seconds * 1000
      : undefined;
  }

  const weekdayForms = [
    /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/,
    /^(?<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT$/,
    /^(?<weekday>Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s{1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/,
  ];
  const match = weekdayForms
    .map((pattern) => pattern.exec(trimmed))
    .find((candidate) => candidate !== null);
  if (match?.groups?.weekday === undefined) return undefined;
  const asctime = match[0]?.endsWith(' GMT') !== true;
  const timestamp = Date.parse(asctime ? `${trimmed} GMT` : trimmed);
  const weekday = new Date(timestamp).getUTCDay();
  const shortWeekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const longWeekdays = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];
  if (
    !Number.isFinite(timestamp) ||
    (match.groups.weekday.length === 3
      ? shortWeekdays[weekday] !== match.groups.weekday
      : longWeekdays[weekday] !== match.groups.weekday)
  ) {
    return undefined;
  }
  return Math.max(0, timestamp - Date.now());
}

function retryDelayMs(
  reason: 'connection' | 'retry_after',
  retryNumber: number,
  random: () => number,
  error: unknown,
): number {
  if (
    reason === 'retry_after' &&
    error instanceof AppError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }
  return random() * Math.min(2_000, 200 * 2 ** (retryNumber - 1));
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const finish = (completed: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(completed);
    };
    const abort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function unconfiguredOperation(operation: OperationId): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Operation is not configured',
    retryable: false,
    cause: new Error(`no adapter registered for ${operation}`),
  });
}

type LoggedDownstreamErrorCode = Extract<
  ErrorCode,
  | 'AI_SERVICE_THROTTLED'
  | 'AI_SERVICE_TIMEOUT'
  | 'AI_SERVICE_UNAVAILABLE'
  | 'AI_SERVICE_ERROR'
  | 'AI_SERVICE_CONTRACT_VIOLATION'
>;

function loggedDownstreamErrorCode(
  error: unknown,
): LoggedDownstreamErrorCode | undefined {
  if (!(error instanceof AppError)) {
    return undefined;
  }

  switch (error.code) {
    case 'AI_SERVICE_THROTTLED':
    case 'AI_SERVICE_TIMEOUT':
    case 'AI_SERVICE_UNAVAILABLE':
    case 'AI_SERVICE_ERROR':
    case 'AI_SERVICE_CONTRACT_VIOLATION':
      return error.code;
    default:
      return undefined;
  }
}

const MAX_LOGGED_REASON_LENGTH = 400;

/**
 * Only a diagnostic an adapter vetted for the log, never the error's `cause`,
 * which can carry anything. Capped so no adapter can flood a log line.
 */
function contractViolationReason(error: unknown): string | undefined {
  if (
    !(error instanceof AppError) ||
    error.code !== 'AI_SERVICE_CONTRACT_VIOLATION' ||
    error.diagnostic === undefined
  ) {
    return undefined;
  }
  return error.diagnostic.slice(0, MAX_LOGGED_REASON_LENGTH);
}

function downstreamFailureMessage(
  code: LoggedDownstreamErrorCode,
  status: number | null,
): string {
  switch (code) {
    case 'AI_SERVICE_ERROR':
    case 'AI_SERVICE_THROTTLED':
      return `downstream status ${status}`;
    case 'AI_SERVICE_TIMEOUT':
      return 'downstream timed out';
    case 'AI_SERVICE_UNAVAILABLE':
      return 'downstream unreachable';
    case 'AI_SERVICE_CONTRACT_VIOLATION':
      return 'downstream response failed contract validation';
  }
}

/** The log context the dispatcher has always logged under. */
export const DISPATCHER_LOG_CONTEXT = 'HttpOperationDispatcher';

interface DownstreamFailure {
  readonly requestId: string;
  readonly operation: OperationId;
  readonly downstream: string;
  readonly path: string;
  readonly status: number | null;
  readonly elapsedMs: number;
}

interface RetryState {
  totalRetries: number;
  connectionRetries: number;
  retriedAfter: boolean;
  firstAttemptCounted: boolean;
}

function downstreamResponseError(
  adapter: DownstreamAdapter<unknown, unknown>,
  response: InternalAIServiceResponse<unknown>,
): AppError | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;
  const hint = adapter.parseError?.(response.status, response.body);
  const retryDelay =
    response.status === 503
      ? retryAfterMs(response.headers['retry-after'])
      : undefined;
  return hint === undefined
    ? mapDownstreamStatus(response.status, retryDelay)
    : new AppError({
        code: hint.code,
        message: hint.message,
        retryable: hint.retryable,
        downstreamStatus: response.status,
        ...(response.status === 503 && retryDelay !== undefined
          ? { retryAfterMs: retryDelay }
          : {}),
      });
}

/**
 * Transport only: adapter lookup, the internal-token header, the HTTP call,
 * the status mapping, and the `downstream_failed` log line. Admission, attempt
 * evidence, and the deadline belong to `GuardedOperationDispatcher`.
 */
export class HttpOperationTransport implements OperationTransportPort {
  // `unknown` on both sides is the one place a dispatch table for a
  // heterogeneous set of adapters has to erase the per-operation types the
  // public `OperationDispatcherPort` generic keeps precise. It is populated
  // solely from the constructor's own `adapters` array, so a lookup by
  // `operation` always returns the one adapter whose real input/output types
  // match that same literal — safe by construction, not by an unchecked
  // cast bypassing a boundary.
  private readonly adapters: ReadonlyMap<
    OperationId,
    DownstreamAdapter<unknown, unknown>
  >;
  private readonly logger = new Logger(DISPATCHER_LOG_CONTEXT);

  constructor(
    private readonly httpClient: DownstreamHttpClient,
    private readonly tokenIssuer: InternalTokenIssuerPort,
    adapters: readonly DownstreamAdapter<unknown, unknown>[],
    private readonly circuitBreakers: DownstreamCircuitBreakers,
    private readonly retryBudget?: DownstreamRetryBudgetPort,
    private readonly random: () => number = Math.random,
  ) {
    this.adapters = new Map(
      adapters.map((adapter) => [adapter.operation, adapter]),
    );
  }

  isUndelivered(error: unknown): boolean {
    return isDefinitelyNotDispatched(error);
  }

  async prepare<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<PreparedDispatch<O>> {
    const adapter = this.adapters.get(operation);
    if (adapter === undefined) {
      throw unconfiguredOperation(operation);
    }

    const downstreamRequest = adapter.buildRequest(input, context);
    const authorization =
      adapter.downstream === 'ai-writing'
        ? `Bearer ${await this.tokenIssuer.mint(context, operation)}`
        : undefined;

    return {
      send: async (call) => {
        const startedAt = performance.now();
        let response: InternalAIServiceResponse<unknown> | undefined;
        let responseStatus: number | undefined;
        const retryState: RetryState = {
          totalRetries: 0,
          connectionRetries: 0,
          retriedAfter: false,
          firstAttemptCounted: false,
        };
        const retryEnabled = this.retryBudget?.isEnabled(operation) ?? false;
        try {
          while (true) {
            if (
              retryEnabled &&
              this.retryBudget !== undefined &&
              !retryState.firstAttemptCounted
            ) {
              retryState.firstAttemptCounted = await this.retryBudget
                .recordFirstAttempt(operation, context.requestId)
                .catch(() => false);
            }
            try {
              response = await this.circuitBreakers.execute(
                operation,
                async () => {
                  const received = await this.httpClient.request(
                    downstreamRequest,
                    {
                      ...(authorization === undefined ? {} : { authorization }),
                      downstream: adapter.downstream,
                      requestId: context.requestId,
                      deadlineMs: Math.max(
                        1,
                        Math.floor(
                          call.deadlineMs - (performance.now() - startedAt),
                        ),
                      ),
                      signal: call.signal,
                      onResponseReceived: (statusCode) => {
                        responseStatus = statusCode;
                        call.onResponseReceived(statusCode);
                      },
                    },
                  );
                  const responseError = downstreamResponseError(
                    adapter,
                    received,
                  );
                  if (responseError !== undefined) throw responseError;
                  return received;
                },
              );
              break;
            } catch (error) {
              if (
                !(await this.scheduleRetry(
                  error,
                  operation,
                  context.requestId,
                  call,
                  startedAt,
                  retryEnabled,
                  retryState,
                ))
              ) {
                throw error;
              }
            }
          }
          // The client reports a response through the callback; repeating it
          // here means a returned response is never classified as unknown.
          call.onResponseReceived(response.status);

          const telemetry = extractDownstreamTelemetry(response.body);
          // The one place the dispatch table's type erasure surfaces as a
          // cast: the adapter registered for this operation literal produced
          // `data`, so its shape matches `ResponseFor<O>` by construction.
          return {
            operation,
            data: adapter.parseResponse(response),
            downstreamMs: Math.round(performance.now() - startedAt),
            ...(telemetry?.usage === undefined
              ? {}
              : { usage: telemetry.usage }),
            ...(telemetry?.models === undefined
              ? {}
              : { models: telemetry.models }),
            ...(telemetry?.aiProcessingMs === undefined
              ? {}
              : { aiProcessingMs: telemetry.aiProcessingMs }),
          } as DispatchResult<ResponseFor<O>>;
        } catch (error) {
          this.logDownstreamFailure(error, {
            requestId: context.requestId,
            operation,
            downstream: adapter.downstream,
            path: downstreamRequest.path,
            status: response?.status ?? responseStatus ?? null,
            elapsedMs: performance.now() - startedAt,
          });
          throw error;
        }
      },
    };
  }

  private async scheduleRetry(
    error: unknown,
    operation: OperationId,
    requestId: string,
    call: TransportCall,
    startedAt: number,
    retryEnabled: boolean,
    state: RetryState,
  ): Promise<boolean> {
    const budget = this.retryBudget;
    const connectionFailure =
      this.isUndelivered(error) && state.connectionRetries < 2;
    const retryAfterFailure =
      !state.retriedAfter &&
      error instanceof AppError &&
      error.downstreamStatus === 503 &&
      error.retryAfterMs !== undefined;
    if (
      !retryEnabled ||
      budget === undefined ||
      (!connectionFailure && !retryAfterFailure)
    ) {
      return false;
    }
    if (!state.firstAttemptCounted) {
      recordDownstreamRetryEvent(operation, 'budget_unavailable');
      return false;
    }

    const reason = connectionFailure ? 'connection' : 'retry_after';
    const retryNumber = state.totalRetries + 1;
    const delayMs = retryDelayMs(reason, retryNumber, this.random, error);
    const expectedAttemptMs = budget.expectedAttemptMs(operation);
    if (
      expectedAttemptMs === undefined ||
      delayMs + expectedAttemptMs >=
        call.deadlineMs - (performance.now() - startedAt) ||
      call.signal.aborted
    ) {
      return false;
    }

    const decision = await budget
      .reserveRetry(operation, requestId, retryNumber)
      .catch(() => 'unavailable' as const);
    if (decision !== 'admitted') {
      if (decision === 'exhausted') {
        recordDownstreamRetryEvent(operation, 'budget_exhausted');
      } else {
        recordDownstreamRetryEvent(operation, 'budget_unavailable');
      }
      return false;
    }
    if (
      delayMs + expectedAttemptMs >=
        call.deadlineMs - (performance.now() - startedAt) ||
      call.signal.aborted ||
      !(await waitForRetry(delayMs, call.signal)) ||
      call.signal.aborted ||
      expectedAttemptMs >= call.deadlineMs - (performance.now() - startedAt)
    ) {
      return false;
    }

    state.totalRetries += 1;
    if (connectionFailure) state.connectionRetries += 1;
    else state.retriedAfter = true;
    recordDownstreamRetryEvent(operation, reason);
    return true;
  }

  private logDownstreamFailure(
    error: unknown,
    failure: DownstreamFailure,
  ): void {
    const errorCode = loggedDownstreamErrorCode(error);
    if (errorCode === undefined) {
      return;
    }
    const reason = contractViolationReason(error);

    this.logger.error(
      JSON.stringify({
        event: 'downstream_failed',
        request_id: failure.requestId,
        operation: failure.operation,
        ai_service: failure.downstream,
        private_endpoint: failure.path,
        downstream_status: failure.status,
        downstream_error_code: null,
        downstream_message: null,
        downstream_ms: Math.max(0, Math.round(failure.elapsedMs)),
        error_code: errorCode,
        message: downstreamFailureMessage(errorCode, failure.status),
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }
}
