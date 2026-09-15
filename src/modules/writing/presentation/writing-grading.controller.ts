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
  type GradeResponse,
  GradeResponseSchema,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  type GradeTask1Request as Task1Request,
  type GradeTask2Request as Task2Request,
} from '../../../contracts/writing/grading';
import {
  readDispatchTelemetry,
  withDispatchTelemetry,
} from '../../gateway/application/dispatch-telemetry';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { getConcurrencyBackgroundLifecycle } from '../../gateway/presentation/concurrency-permit';
import { ConcurrencyReleaseInterceptor } from '../../gateway/presentation/concurrency-release.interceptor';
import { ConcurrencyGuard } from '../../gateway/presentation/concurrency.guard';
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

const TASK1_OPERATION = 'writing.task1.grade' as const;
const TASK2_OPERATION = 'writing.task2.grade' as const;

function invalidRequest(cause?: unknown): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message: 'Request failed validation',
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
  });
}

// Body size is enforced earlier, before parsing, by the `onRequest` hook
// registered in main.ts (see `registerBodySizeGuard`) — a body that reaches
// here has already passed that check.
function parseTask1Body(body: unknown): Task1Request {
  if (!Value.Check(GradeTask1RequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(GradeTask1RequestSchema, body);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function parseTask2Body(body: unknown): Task2Request {
  if (!Value.Check(GradeTask2RequestSchema, body)) {
    throw invalidRequest();
  }

  try {
    return Value.Parse(GradeTask2RequestSchema, body);
  } catch (error) {
    throw invalidRequest(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function decodeTask1Replay(value: unknown): DispatchResult<GradeResponse> {
  if (
    !isRecord(value) ||
    value.operation !== TASK1_OPERATION ||
    typeof value.downstreamMs !== 'number' ||
    !Number.isFinite(value.downstreamMs) ||
    value.downstreamMs < 0 ||
    !('data' in value) ||
    !Value.Check(GradeResponseSchema, value.data)
  ) {
    throw new Error('stored Task 1 grading response is malformed');
  }

  return withDispatchTelemetry(
    {
      operation: TASK1_OPERATION,
      data: Value.Parse(GradeResponseSchema, value.data),
      downstreamMs: value.downstreamMs,
    },
    readDispatchTelemetry(value),
  );
}

function decodeTask2Replay(value: unknown): DispatchResult<GradeResponse> {
  if (
    !isRecord(value) ||
    value.operation !== TASK2_OPERATION ||
    typeof value.downstreamMs !== 'number' ||
    !Number.isFinite(value.downstreamMs) ||
    value.downstreamMs < 0 ||
    !('data' in value) ||
    !Value.Check(GradeResponseSchema, value.data)
  ) {
    throw new Error('stored Task 2 grading response is malformed');
  }

  return withDispatchTelemetry(
    {
      operation: TASK2_OPERATION,
      data: Value.Parse(GradeResponseSchema, value.data),
      downstreamMs: value.downstreamMs,
    },
    readDispatchTelemetry(value),
  );
}

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.aihubIdentity?.userId;
  if (userId === undefined || userId.trim().length === 0) {
    throw new AppError({
      code: 'USER_ASSERTION_REQUIRED',
      message: 'A valid user assertion is required',
      retryable: false,
    });
  }
  return userId;
}

/**
 * Both grading operations in one controller: they return the same
 * `GradeResponse` shape and differ only in request schema and which
 * operation they dispatch. Two near-identical classes would only duplicate
 * the class-level guard/interceptor wiring for no benefit.
 */
@Controller()
@UseGuards(ApiKeyGuard, UserAssertionGuard, RateLimitGuard, ConcurrencyGuard)
@UseInterceptors(ConcurrencyReleaseInterceptor, SuccessEnvelopeInterceptor)
export class WritingGradingController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
    @Inject(IDEMPOTENCY_SERVICE)
    private readonly idempotency: IdempotencyServicePort,
  ) {}

  @Post(OPERATION_CATALOG[TASK1_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK1_OPERATION)
  async gradeTask1(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    const input = parseTask1Body(body);
    const authenticated = getAuthenticatedApiKey(request);
    const actorId = requireUserId(request);
    const idempotencyKey = resolveIdempotencyKey(
      TASK1_OPERATION,
      request.headers['idempotency-key'],
    );
    const backgroundLifecycle = getConcurrencyBackgroundLifecycle(request);
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const requestId = String(request.id);
      const context = createRequestContext({
        requestId,
        receivedAt: new Date(),
        deadlineMs: OPERATION_CATALOG[TASK1_OPERATION].timeoutMs,
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
          operation: TASK1_OPERATION,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          actorId,
          requestBody: input,
          requestId,
          timeoutMs: OPERATION_CATALOG[TASK1_OPERATION].timeoutMs,
          signal: context.signal,
          deadlineAt: context.deadlineAt,
          ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
        },
        (workContext: IdempotencyWorkContext) =>
          this.dispatcher.dispatch(TASK1_OPERATION, input, {
            ...context,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          }),
        decodeTask1Replay,
      );

      return execution.replay
        ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
        : execution.result;
    } finally {
      dispose();
    }
  }

  @Post(OPERATION_CATALOG[TASK2_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK2_OPERATION)
  async gradeTask2(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    const input = parseTask2Body(body);
    const authenticated = getAuthenticatedApiKey(request);
    const actorId = requireUserId(request);
    const idempotencyKey = resolveIdempotencyKey(
      TASK2_OPERATION,
      request.headers['idempotency-key'],
    );
    const backgroundLifecycle = getConcurrencyBackgroundLifecycle(request);
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const requestId = String(request.id);
      const context = createRequestContext({
        requestId,
        receivedAt: new Date(),
        deadlineMs: OPERATION_CATALOG[TASK2_OPERATION].timeoutMs,
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
          operation: TASK2_OPERATION,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
          actorId,
          requestBody: input,
          requestId,
          timeoutMs: OPERATION_CATALOG[TASK2_OPERATION].timeoutMs,
          signal: context.signal,
          deadlineAt: context.deadlineAt,
          ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
        },
        (workContext: IdempotencyWorkContext) =>
          this.dispatcher.dispatch(TASK2_OPERATION, input, {
            ...context,
            signal: workContext.signal,
            deadlineAt: workContext.deadlineAt,
          }),
        decodeTask2Replay,
      );

      return execution.replay
        ? { ...execution.result, downstreamMs: 0, idempotentReplay: true }
        : execution.result;
    } finally {
      dispose();
    }
  }
}
