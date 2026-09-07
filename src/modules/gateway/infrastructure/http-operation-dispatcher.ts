import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import type { OperationId } from '../../../catalog/operation-id';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  GradeResponse,
  GradeTask1Request,
  GradeTask2Request,
} from '../../../contracts/writing/grading';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../../contracts/writing/task1';
import type {
  Task2QuestionRequest,
  Task2QuestionResponse,
} from '../../../contracts/writing/task2';
import type { DownstreamAdapter } from '../../../downstream/downstream-adapter';
import type { InternalTokenIssuerPort } from '../application/internal-token-issuer.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from '../application/operation-dispatcher.port';
import type { DownstreamHttpClient } from './downstream-http.client';

function mapDownstreamStatus(status: number): AppError {
  if (status === 429) {
    return new AppError({
      code: 'AI_SERVICE_THROTTLED',
      message: 'AI service is temporarily throttled',
      httpStatus: 503,
      retryable: true,
    });
  }

  return new AppError({
    code: 'AI_SERVICE_ERROR',
    message: 'AI service returned an error',
    httpStatus: 502,
    retryable: status >= 500,
    cause: new Error(`downstream status ${status}`),
  });
}

function unconfiguredOperation(operation: OperationId): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    message: 'Operation is not configured',
    httpStatus: 500,
    retryable: false,
    cause: new Error(`no adapter registered for ${operation}`),
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

  constructor(
    private readonly httpClient: DownstreamHttpClient,
    private readonly tokenIssuer: InternalTokenIssuerPort,
    adapters: readonly DownstreamAdapter<unknown, unknown>[],
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
    operation: 'writing.task1.question.generate',
    input: Task1QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task1QuestionResponse>>;
  dispatch(
    operation: 'writing.task2.question.generate',
    input: Task2QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task2QuestionResponse>>;
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
    const token = await this.tokenIssuer.mint(context, operation);
    const operationTimeoutMs = OPERATION_CATALOG[operation].timeoutMs;
    const remainingMs = Math.max(1, context.deadlineAt.getTime() - Date.now());
    const timeoutMs = Math.min(operationTimeoutMs, remainingMs);
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(timeoutMs),
    ]);
    const startedAt = performance.now();

    const response = await this.httpClient.request(downstreamRequest, {
      authorization: `Bearer ${token}`,
      requestId: context.requestId,
      deadlineMs: timeoutMs,
      signal,
    });
    const downstreamMs = Math.round(performance.now() - startedAt);

    if (response.status < 200 || response.status >= 300) {
      throw mapDownstreamStatus(response.status);
    }

    return {
      operation,
      data: adapter.parseResponse(response),
      downstreamMs,
    };
  }
}
