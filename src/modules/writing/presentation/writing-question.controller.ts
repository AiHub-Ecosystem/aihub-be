import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from '../../../catalog/operation-catalog';
import { AppError } from '../../../common/errors/app-error';
import { createClientDisconnectSignal } from '../../../common/http/client-disconnect-signal';
import { SuccessEnvelopeInterceptor } from '../../../common/http/success-envelope.interceptor';
import { createRequestContext } from '../../../common/request-context/request-context.factory';
import {
  type Task1QuestionRequest,
  Task1QuestionRequestSchema,
  type Task1QuestionResponse,
  Task1QuestionResponseSchema,
} from '../../../contracts/writing/task1';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
import {
  IDEMPOTENCY_SERVICE,
  type IdempotencyServicePort,
  type IdempotencyWorkContext,
} from '../../idempotency/application/idempotency-service.port';
import { resolveIdempotencyKey } from '../../idempotency/presentation/idempotency-key';
import { ApiKeyGuard } from '../../identity/presentation/api-key.guard';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '../../identity/presentation/authenticated-request';
import { RequireOperation } from '../../identity/presentation/require-operation.decorator';
import { UserAssertionGuard } from '../../identity/presentation/user-assertion.guard';

const OPERATION = 'writing.task1.question.generate' as const;

function invalidRequest(): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    httpStatus: 400,
    retryable: false,
  });
}

// Body size is enforced earlier, before parsing, by the `onRequest` hook
// registered in main.ts (see `registerBodySizeGuard`) — a body that reaches
// here has already passed that check.
function parseBody(body: unknown): Task1QuestionRequest {
  if (!Value.Check(Task1QuestionRequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(Task1QuestionRequestSchema, body);
  } catch (error) {
    throw new AppError({
      code: 'INVALID_REQUEST',
      message: 'Request failed validation',
      httpStatus: 400,
      retryable: false,
      cause: error,
    });
  }
}

function decodeReplay(value: unknown): DispatchResult<Task1QuestionResponse> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('operation' in value) ||
    value.operation !== OPERATION ||
    !('downstreamMs' in value) ||
    typeof value.downstreamMs !== 'number' ||
    !Number.isFinite(value.downstreamMs) ||
    value.downstreamMs < 0 ||
    !('data' in value) ||
    !Value.Check(Task1QuestionResponseSchema, value.data)
  ) {
    throw new Error('stored Task 1 question response is malformed');
  }

  return {
    operation: OPERATION,
    data: Value.Parse(Task1QuestionResponseSchema, value.data),
    downstreamMs: value.downstreamMs,
  };
}

@Controller()
@UseGuards(ApiKeyGuard, UserAssertionGuard, RateLimitGuard)
@UseInterceptors(SuccessEnvelopeInterceptor)
export class WritingQuestionController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency: IdempotencyServicePort,
  ) {}

  @Post(OPERATION_CATALOG[OPERATION].path)
  @HttpCode(200)
  @RequireOperation(OPERATION)
  async generateTask1Question(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<Task1QuestionResponse>> {
    const input = parseBody(body);
    const authenticated = getAuthenticatedApiKey(request);
    const idempotencyKey = resolveIdempotencyKey(
      OPERATION,
      request.headers['idempotency-key'],
    );
    // Ties the dispatch's AbortSignal to this specific request's connection,
    // not only to the operation timeout, so a client that disconnects early
    // stops the downstream call instead of letting it run to completion for
    // no one.
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const context = createRequestContext({
        requestId: String(request.id),
        receivedAt: new Date(),
        deadlineMs: OPERATION_CATALOG[OPERATION].timeoutMs,
        organizationId: authenticated.organizationId,
        apiKeyId: authenticated.apiKeyId,
        ...(request.aihubIdentity === undefined
          ? {}
          : { userId: request.aihubIdentity.userId }),
        scopes: authenticated.scopes,
        signal,
      });

      const execution = await this.idempotency.execute(
        {
          organizationId: authenticated.organizationId,
          operation: OPERATION,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          actorId: authenticated.organizationId,
          requestBody: input,
          requestId: String(request.id),
          timeoutMs: OPERATION_CATALOG[OPERATION].timeoutMs,
          signal: context.signal,
          deadlineAt: context.deadlineAt,
        },
        (workContext: IdempotencyWorkContext) =>
          this.dispatcher.dispatch(OPERATION, input, {
            ...context,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          }),
        decodeReplay,
      );

      return execution.replay
        ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
        : execution.result;
    } finally {
      dispose();
    }
  }
}
