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
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/operation-dispatcher.port';
import type {
  OperationTransportPort,
  PreparedDispatch,
} from '@/modules/gateway/application/operation-transport.port';
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
        try {
          response = await this.httpClient.request(downstreamRequest, {
            ...(authorization === undefined ? {} : { authorization }),
            downstream: adapter.downstream,
            requestId: context.requestId,
            deadlineMs: call.deadlineMs,
            signal: call.signal,
            onResponseReceived: (statusCode) => {
              responseStatus = statusCode;
              call.onResponseReceived(statusCode);
            },
          });
          // The client reports a response through the callback; repeating it
          // here means a returned response is never classified as unknown.
          call.onResponseReceived(response.status);
          if (response.status < 200 || response.status >= 300) {
            // A failure body is not a grading, so the adapter reads it before
            // any contract validation; a failure it cannot name keeps the
            // status mapping.
            const hint = adapter.parseError?.(response.status, response.body);
            throw hint === undefined
              ? mapDownstreamStatus(response.status)
              : new AppError({
                  code: hint.code,
                  message: hint.message,
                  retryable: hint.retryable,
                  downstreamStatus: response.status,
                });
          }

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
