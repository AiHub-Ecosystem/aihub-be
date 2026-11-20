import { Logger } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import type { OperationId } from '@/catalog/operation-id';
import { AppError, internalError } from '@/common/errors/app-error';
import { isDownstreamCredentialRejection } from '@/common/errors/downstream-fault';
import type { ErrorCode } from '@/common/errors/error-code';
import { parseRetryAfter } from '@/common/http/retry-after';
import { isRecord } from '@/common/is-record';
import { recordDownstreamCredentialRejection } from '@/common/observability/metrics';
import type { RequestContext } from '@/common/request-context/request-context';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type { InternalAIServiceResponse } from '@/downstream/downstream.types';
import type { InternalTokenIssuerPort } from '@/modules/gateway/application/dispatch/internal-token-issuer.port';
import type {
  DispatchResult,
  RequestFor,
  ResponseFor,
} from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import type {
  OperationTransportPort,
  PreparedDispatch,
} from '@/modules/gateway/application/dispatch/operation-transport.port';
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
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }

  // The customer sees the answer a connection failure gives; the log and the
  // credential counter say why (#845).
  if (isDownstreamCredentialRejection(status)) {
    return new AppError({
      code: 'AI_SERVICE_UNAVAILABLE',
      message: 'AI service is temporarily unavailable',
      retryable: true,
      downstreamStatus: status,
      cause: internalError(`downstream status ${status}`),
    });
  }

  return new AppError({
    code: 'AI_SERVICE_ERROR',
    message: 'AI service returned an error',
    // 408 and 425 ask the sender to repeat the request (RFC 9110 §15.5.9).
    retryable: status >= 500 || status === 408 || status === 425,
    downstreamStatus: status,
    ...(status === 503 && retryAfterMs !== undefined ? { retryAfterMs } : {}),
    cause: internalError(`downstream status ${status}`),
  });
}

function unconfiguredOperation(operation: OperationId): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Operation is not configured',
    retryable: false,
    cause: internalError(`no adapter registered for ${operation}`),
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

/** Above this, a browser's 32-bit `setTimeout` wraps to 1 ms. */
export const MAX_RETRY_AFTER_MS = 2_147_483_647;

function boundedRetryAfterMs(
  header: string | undefined,
  now: Date,
): number | undefined {
  const delay = parseRetryAfter(header, now);
  return delay === undefined ? undefined : Math.min(delay, MAX_RETRY_AFTER_MS);
}

interface DownstreamFailure {
  readonly requestId: string;
  readonly operation: OperationId;
  readonly downstream: string;
  readonly path: string;
  readonly status: number | null;
  readonly elapsedMs: number;
}

function downstreamResponseError(
  adapter: DownstreamAdapter<unknown, unknown>,
  response: InternalAIServiceResponse<unknown>,
  now: Date,
): AppError | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;
  const hint = adapter.parseError?.(response.status, response.body);
  const retryDelay =
    response.status === 503 || response.status === 429
      ? boundedRetryAfterMs(response.headers['retry-after'], now)
      : undefined;
  return hint === undefined
    ? mapDownstreamStatus(response.status, retryDelay)
    : new AppError({
        code: hint.code,
        message: hint.message,
        retryable: hint.retryable,
        downstreamStatus: response.status,
        ...(retryDelay !== undefined ? { retryAfterMs: retryDelay } : {}),
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
    private readonly now: () => Date = () => new Date(),
  ) {
    const registry = new Map(
      adapters.map((adapter) => [adapter.operation, adapter]),
    );
    if (registry.size !== adapters.length) {
      throw internalError('Duplicate downstream adapter registration');
    }
    this.adapters = registry;
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

    const builtRequest = adapter.buildRequest(input, context);
    const downstreamRequest =
      builtRequest.method === 'GET'
        ? {
            ...builtRequest,
            path: resolvePathParameters(builtRequest.path, input),
          }
        : builtRequest;
    const authorization =
      adapter.downstream === 'ai-writing'
        ? `Bearer ${await this.tokenIssuer.mint(context, operation)}`
        : undefined;

    // An operation whose adapter is registered before its catalog entry reads
    // with the client's default limit, so no response is ever read unbounded.
    const responseLimit = Object.hasOwn(OPERATION_CATALOG, operation)
      ? OPERATION_CATALOG[operation].maxResponseBytes
      : undefined;

    return {
      send: async (call) => {
        const startedAt = performance.now();
        let response: InternalAIServiceResponse<unknown> | undefined;
        let responseStatus: number | undefined;
        try {
          response = await this.circuitBreakers.execute(operation, async () => {
            await call.onAttemptAdmitted?.();
            const received = await this.httpClient.request(downstreamRequest, {
              ...(authorization === undefined ? {} : { authorization }),
              downstream: adapter.downstream,
              requestId: context.requestId,
              deadlineMs: call.deadlineMs,
              ...(responseLimit === undefined
                ? {}
                : { maxResponseBytes: responseLimit }),
              signal: call.signal,
              onResponseReceived: (statusCode) => {
                responseStatus = statusCode;
                call.onResponseReceived(statusCode);
              },
            });
            const responseError = downstreamResponseError(
              adapter,
              received,
              this.now(),
            );
            if (responseError !== undefined) throw responseError;
            return received;
          });
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

  private logDownstreamFailure(
    error: unknown,
    failure: DownstreamFailure,
  ): void {
    const errorCode = loggedDownstreamErrorCode(error);
    if (errorCode === undefined) {
      return;
    }
    const reason = contractViolationReason(error);
    const credentialRejected =
      failure.status !== null &&
      isDownstreamCredentialRejection(failure.status);
    if (credentialRejected) {
      recordDownstreamCredentialRejection(
        failure.operation,
        failure.downstream,
      );
    }

    this.logger.error({
      event: credentialRejected
        ? 'downstream_credential_rejected'
        : 'downstream_failed',
      request_id: failure.requestId,
      operation: failure.operation,
      ai_service: failure.downstream,
      private_endpoint: failure.path,
      downstream_status: failure.status,
      downstream_error_code: null,
      downstream_message: null,
      downstream_ms: Math.max(0, Math.round(failure.elapsedMs)),
      error_code: errorCode,
      message: credentialRejected
        ? `downstream status ${failure.status}`
        : downstreamFailureMessage(errorCode, failure.status),
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export function resolvePathParameters(path: string, input: unknown): string {
  const values = isRecord(input) ? input : {};
  return path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    if (typeof values[name] !== 'string') {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Operation path parameters are not configured',
        retryable: false,
      });
    }
    return encodeURIComponent(values[name]);
  });
}
