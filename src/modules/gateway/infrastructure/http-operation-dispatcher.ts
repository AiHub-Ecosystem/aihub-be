import { Logger } from '@nestjs/common';

import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import type { ErrorCode } from '../../../common/errors/error-code';
import type { RequestContext } from '../../../common/request-context/request-context';
import { extractDownstreamTelemetry } from '../../../common/request-metering/telemetry';
import type {
  SpeakingGradeInput,
  SpeakingGradeJsonInput,
  SpeakingGradeResponse,
} from '../../../contracts/speaking/grading';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '../../../contracts/writing/grading';
import type { DownstreamAdapter } from '../../../downstream/downstream-adapter';
import type { InternalAIServiceResponse } from '../../../downstream/downstream.types';
import type { InternalTokenIssuerPort } from '../application/internal-token-issuer.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from '../application/operation-dispatcher.port';
import type { SandboxDispatchBudgetPort } from '../application/sandbox-dispatch-budget.port';
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

export class HttpOperationDispatcher implements OperationDispatcherPort {
  // `unknown` on both sides is the one place a dispatch table for a
  // heterogeneous set of adapters has to erase the per-operation types the
  // public `OperationDispatcherPort` overloads keep precise. It is populated
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
    private readonly sandboxBudget?: SandboxDispatchBudgetPort,
  ) {
    this.adapters = new Map(
      adapters.map((adapter) => [adapter.operation, adapter]),
    );
  }

  // Repeats `OperationDispatcherPort`'s overloads here, immediately followed
  // by the one broader implementation signature below — the standard
  // TypeScript pattern for an overloaded method, so every external caller
  // sees only the four precise signatures and the internal, type-erased
  // implementation never leaks out as part of the public type.
  dispatch(
    operation: 'writing.task1.grade',
    input: GradeTask1Request,
    context: RequestContext,
  ): Promise<DispatchResult<GradeResponse>>;
  dispatch(
    operation: 'writing.task2.grade',
    input: GradeTask2Request,
    context: RequestContext,
  ): Promise<DispatchResult<GradeResponse>>;
  dispatch(
    operation: 'speaking.grading',
    input: SpeakingGradeInput,
    context: RequestContext,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  dispatch(
    operation: 'speaking.grading-json',
    input: SpeakingGradeJsonInput,
    context: RequestContext,
  ): Promise<DispatchResult<SpeakingGradeResponse>>;
  async dispatch(
    operation: OperationId,
    input: unknown,
    context: RequestContext,
  ): Promise<DispatchResult<unknown>> {
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
    let downstreamDispatchStarted = false;

    try {
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
      });

      if (response.status < 200 || response.status >= 300) {
        throw mapDownstreamStatus(response.status);
      }

      const telemetry = extractDownstreamTelemetry(response.body);
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
      };
    } catch (error) {
      if (
        sandboxRequest &&
        (isDefinitelyNotDispatched(error) ||
          (!downstreamDispatchStarted && (signal.aborted || deadlineExpired())))
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
        const downstreamStatus = response?.status ?? null;
        const downstreamMs = Math.max(
          0,
          Math.round(performance.now() - startedAt),
        );

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
          }),
        );
      }

      throw error;
    }
  }
}
