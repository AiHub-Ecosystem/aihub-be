import { Logger } from '@nestjs/common';

import type { OperationId } from '@/catalog/operation-id';
import { AppError } from '@/common/errors/app-error';
import type { ErrorCode } from '@/common/errors/error-code';
import type { RequestContext } from '@/common/request-context/request-context';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/internal-token-issuer.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/operation-dispatcher.port';
import type { SandboxDispatchBudgetPort } from '@/modules/gateway/application/sandbox-dispatch-budget.port';
import type {
  DispatchAttemptOutcome,
  RecordDispatchAttemptPort,
} from '@/modules/metering/public/dispatch-attempts';
import { extractDownstreamTelemetry } from '@/modules/metering/public/telemetry';
import {
  type DownstreamHttpClient,
  isDefinitelyNotDispatched,
} from './downstream-http.client';

function mapDownstreamStatus(status: number): AppError {
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
    cause: new Error(`downstream status ${status}`),
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

function quotaExceeded(now: Date): AppError {
  const nextMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  return new AppError({
    code: 'QUOTA_EXCEEDED',
    message: 'Monthly request quota exceeded',
    retryable: true,
    retryAfterMs: Math.max(0, nextMonth.getTime() - now.getTime()),
  });
}

function sandboxBudgetUnavailable(): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Sandbox dispatch admission is unavailable',
    retryable: true,
  });
}

function dispatchTimedOut(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    retryable: true,
  });
}

function dispatchEvidenceUnavailable(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Dispatch evidence is temporarily unavailable',
    retryable: true,
    cause,
  });
}

export class HttpOperationDispatcher implements OperationDispatcherPort {
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
  private readonly logger = new Logger(HttpOperationDispatcher.name);

  constructor(
    private readonly httpClient: DownstreamHttpClient,
    private readonly tokenIssuer: InternalTokenIssuerPort,
    adapters: readonly DownstreamAdapter<unknown, unknown>[],
    private readonly dispatchAttempts: RecordDispatchAttemptPort,
    private readonly sandboxBudget?: SandboxDispatchBudgetPort,
  ) {
    this.adapters = new Map(
      adapters.map((adapter) => [adapter.operation, adapter]),
    );
  }

  async dispatch<O extends OperationId>(
    operation: O,
    input: RequestFor<O>,
    context: RequestContext,
  ): Promise<DispatchResult<ResponseFor<O>>> {
    const adapter = this.adapters.get(operation);
    if (adapter === undefined) {
      throw unconfiguredOperation(operation);
    }

    const downstreamRequest = adapter.buildRequest(input, context);
    const authorization =
      adapter.downstream === 'ai-writing'
        ? `Bearer ${await this.tokenIssuer.mint(context, operation)}`
        : undefined;
    const remainingMs = Math.max(1, context.deadlineAt.getTime() - Date.now());
    const timeoutMs = remainingMs;
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const sandboxRequest = context.environment === 'sandbox';
    const deadlineExpired = (): boolean =>
      context.deadlineAt.getTime() <= Date.now();
    if (sandboxRequest && (signal.aborted || deadlineExpired())) {
      throw dispatchTimedOut();
    }

    if (sandboxRequest) {
      const organizationId = context.organizationId;
      const organizationLimit = context.sandboxOrganizationDispatchLimit;
      if (
        this.sandboxBudget === undefined ||
        organizationId === undefined ||
        organizationLimit === undefined
      ) {
        throw sandboxBudgetUnavailable();
      }
      let admitted: boolean;
      try {
        admitted = await this.sandboxBudget.reserve({
          organizationId,
          requestId: context.requestId,
          organizationLimit,
        });
      } catch {
        throw sandboxBudgetUnavailable();
      }
      if (signal.aborted || deadlineExpired()) {
        if (admitted) {
          await this.sandboxBudget
            .release(context.requestId)
            .catch(() =>
              this.logger.warn(
                'Sandbox dispatch reservation could not be released after a pre-dispatch failure',
              ),
            );
        }
        throw dispatchTimedOut();
      }
      if (!admitted) {
        throw quotaExceeded(new Date());
      }
    }
    const startedAt = performance.now();
    let response: InternalAIServiceResponse<unknown> | undefined;
    let downstreamResponseStatus: number | undefined;
    let downstreamDispatchStarted = false;
    let attemptId: string | undefined;

    try {
      if (signal.aborted || deadlineExpired()) {
        throw dispatchTimedOut();
      }
      if (context.organizationId === undefined) {
        throw dispatchEvidenceUnavailable(
          new Error('organization context is required'),
        );
      }
      try {
        attemptId = await this.dispatchAttempts.beginAttempt({
          requestId: context.requestId,
          organizationId: context.organizationId,
          operation,
          operationTimeoutMs: context.operationTimeoutMs,
        });
      } catch (error) {
        throw dispatchEvidenceUnavailable(error);
      }
      if (signal.aborted || deadlineExpired()) {
        throw dispatchTimedOut();
      }
      downstreamDispatchStarted = true;
      response = await this.httpClient.request(downstreamRequest, {
        ...(authorization === undefined ? {} : { authorization }),
        downstream: adapter.downstream,
        requestId: context.requestId,
        deadlineMs: timeoutMs,
        signal,
        onResponseReceived: (statusCode) => {
          downstreamResponseStatus = statusCode;
        },
      });
      await this.recordAttemptOutcome(attemptId, 'response_received');

      if (response.status < 200 || response.status >= 300) {
        throw mapDownstreamStatus(response.status);
      }

      const telemetry = extractDownstreamTelemetry(response.body);
      // The one place the dispatch table's type erasure surfaces as a cast:
      // the adapter registered for this operation literal produced `data`,
      // so its shape matches `ResponseFor<O>` by construction.
      return {
        operation,
        data: adapter.parseResponse(response),
        downstreamMs: Math.round(performance.now() - startedAt),
        ...(telemetry?.usage === undefined ? {} : { usage: telemetry.usage }),
        ...(telemetry?.models === undefined
          ? {}
          : { models: telemetry.models }),
        ...(telemetry?.aiProcessingMs === undefined
          ? {}
          : { aiProcessingMs: telemetry.aiProcessingMs }),
      } as DispatchResult<ResponseFor<O>>;
    } catch (error) {
      if (attemptId !== undefined && response === undefined) {
        let outcome: DispatchAttemptOutcome;
        if (downstreamResponseStatus !== undefined) {
          outcome = 'response_received';
        } else if (
          !downstreamDispatchStarted ||
          isDefinitelyNotDispatched(error)
        ) {
          outcome = 'not_dispatched';
        } else {
          outcome = 'outcome_unknown';
        }
        await this.recordAttemptOutcome(attemptId, outcome);
      }
      if (
        sandboxRequest &&
        (!downstreamDispatchStarted || isDefinitelyNotDispatched(error))
      ) {
        await this.sandboxBudget
          ?.release(context.requestId)
          .catch(() =>
            this.logger.warn(
              'Sandbox dispatch reservation could not be released after a pre-dispatch failure',
            ),
          );
      }
      const errorCode = downstreamDispatchStarted
        ? loggedDownstreamErrorCode(error)
        : undefined;
      if (errorCode !== undefined) {
        const downstreamStatus =
          response?.status ?? downstreamResponseStatus ?? null;
        const downstreamMs = Math.max(
          0,
          Math.round(performance.now() - startedAt),
        );

        const reason = contractViolationReason(error);

        this.logger.error(
          JSON.stringify({
            event: 'downstream_failed',
            request_id: context.requestId,
            operation,
            ai_service: adapter.downstream,
            private_endpoint: downstreamRequest.path,
            downstream_status: downstreamStatus,
            downstream_error_code: null,
            downstream_message: null,
            downstream_ms: downstreamMs,
            error_code: errorCode,
            message: downstreamFailureMessage(errorCode, downstreamStatus),
            ...(reason === undefined ? {} : { reason }),
          }),
        );
      }

      throw error;
    }
  }

  private async recordAttemptOutcome(
    attemptId: string,
    outcome: DispatchAttemptOutcome,
  ): Promise<void> {
    try {
      await this.dispatchAttempts.recordOutcome(attemptId, outcome);
    } catch {
      this.logger.warn('Dispatch attempt outcome could not be recorded');
    }
  }
}
