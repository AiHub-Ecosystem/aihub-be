import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import { AppError } from '../../../common/errors/app-error';
import type { RequestContext } from '../../../common/request-context/request-context';
import type {
  Task1QuestionRequest,
  Task1QuestionResponse,
} from '../../../contracts/writing/task1';
import type { DownstreamAdapter } from '../../../downstream/downstream-adapter';
import type { InternalTokenIssuerPort } from '../application/internal-token-issuer.port';
import type {
  DispatchResult,
  OperationDispatcherPort,
} from '../application/operation-dispatcher.port';
import type { DownstreamHttpClient } from './downstream-http.client';

const OPERATION = 'writing.task1.question.generate' as const;

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

export class HttpOperationDispatcher implements OperationDispatcherPort {
  constructor(
    private readonly httpClient: DownstreamHttpClient,
    private readonly tokenIssuer: InternalTokenIssuerPort,
    private readonly adapter: DownstreamAdapter<
      Task1QuestionRequest,
      Task1QuestionResponse
    >,
  ) {}

  async dispatch(
    operation: typeof OPERATION,
    input: Task1QuestionRequest,
    context: RequestContext,
  ): Promise<DispatchResult<Task1QuestionResponse>> {
    if (operation !== OPERATION) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Operation is not configured',
        httpStatus: 500,
        retryable: false,
      });
    }

    const downstreamRequest = this.adapter.buildRequest(input, context);
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
      data: this.adapter.parseResponse(response),
      downstreamMs,
    };
  }
}
