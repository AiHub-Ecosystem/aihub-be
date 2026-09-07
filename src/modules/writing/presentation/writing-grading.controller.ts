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
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  type GradeTask1Request as Task1Request,
  type GradeTask2Request as Task2Request,
} from '../../../contracts/writing/grading';
import {
  type DispatchResult,
  OPERATION_DISPATCHER,
  type OperationDispatcherPort,
} from '../../gateway/application/operation-dispatcher.port';
import { RateLimitGuard } from '../../gateway/presentation/rate-limit.guard';
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
    httpStatus: 400,
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

/**
 * Both grading operations in one controller: they return the same
 * `GradeResponse` shape and differ only in request schema and which
 * operation they dispatch. Two near-identical classes would only duplicate
 * the class-level guard/interceptor wiring for no benefit.
 */
@Controller()
@UseGuards(ApiKeyGuard, UserAssertionGuard, RateLimitGuard)
@UseInterceptors(SuccessEnvelopeInterceptor)
export class WritingGradingController {
  constructor(
    @Inject(OPERATION_DISPATCHER)
    private readonly dispatcher: OperationDispatcherPort,
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
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const context = createRequestContext({
        requestId: String(request.id),
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

      return await this.dispatcher.dispatch(TASK1_OPERATION, input, context);
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
    const { signal, dispose } = createClientDisconnectSignal(request.raw);

    try {
      const context = createRequestContext({
        requestId: String(request.id),
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

      return await this.dispatcher.dispatch(TASK2_OPERATION, input, context);
    } finally {
      dispose();
    }
  }
}
