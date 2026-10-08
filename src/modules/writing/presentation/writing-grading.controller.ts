import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import {
  type RequestLifecycleState,
  getRequestLifecycle,
} from '@/common/http/request-lifecycle.hook';
import {
  type GradeResponse,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
  type GradeTask1Request as Task1Request,
  type GradeTask2Request as Task2Request,
} from '@/contracts/writing/grading';
import {
  GRADING_ORCHESTRATOR,
  type GradingOrchestratorPort,
  type GradingRequestMetadata,
} from '@/modules/gateway/application/grading-orchestrator.port';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { getConcurrencyBackgroundLifecycle } from '@/modules/gateway/presentation/concurrency-permit';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import { resolveIdempotencyKey } from '@/modules/idempotency/public/idempotency-key';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';

const TASK1_OPERATION = 'writing.task1.grade' as const;
const TASK2_OPERATION = 'writing.task2.grade' as const;

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

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.aihubIdentity?.userId;
  if (userId === undefined || userId.trim().length === 0) {
    throw userIdentityRequired();
  }
  return userId;
}

function requestLifecycle(
  request: AuthenticatedRequest,
): RequestLifecycleState {
  const lifecycle = getRequestLifecycle(request.raw);
  if (lifecycle === undefined) {
    throw new Error('request lifecycle state is missing');
  }
  return lifecycle;
}

function requestMetadata(
  request: AuthenticatedRequest,
  lifecycle: RequestLifecycleState,
): GradingRequestMetadata {
  const authenticated = getAuthenticatedApiKey(request);
  return {
    requestId: String(request.id),
    receivedAt: lifecycle.receivedAt,
    signal: lifecycle.signal,
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
    ...(authenticated.sandboxOrganizationDispatchLimit === undefined
      ? {}
      : {
          sandboxOrganizationDispatchLimit:
            authenticated.sandboxOrganizationDispatchLimit,
        }),
    userId: requireUserId(request),
    scopes: authenticated.scopes,
  };
}

/**
 * Both grading operations in one controller: they return the same
 * `GradeResponse` shape and differ only in request schema and which
 * operation they dispatch. Two near-identical classes would only duplicate
 * the class-level guard/interceptor wiring for no benefit.
 */
@Controller()
@GradedRequest()
export class WritingGradingController {
  constructor(
    @Inject(GRADING_ORCHESTRATOR)
    private readonly orchestrator: GradingOrchestratorPort,
  ) {}

  @Post(OPERATION_CATALOG[TASK1_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK1_OPERATION)
  async gradeTask1(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    const input = parseTask1Body(body);
    const idempotencyKey = resolveIdempotencyKey(
      TASK1_OPERATION,
      request.headers['idempotency-key'],
    );
    const backgroundLifecycle = getConcurrencyBackgroundLifecycle(request);
    const lifecycle = requestLifecycle(request);

    try {
      return await this.orchestrator.execute({
        operation: TASK1_OPERATION,
        input,
        ...requestMetadata(request, lifecycle),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
      });
    } finally {
      lifecycle.dispose();
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
    const idempotencyKey = resolveIdempotencyKey(
      TASK2_OPERATION,
      request.headers['idempotency-key'],
    );
    const backgroundLifecycle = getConcurrencyBackgroundLifecycle(request);
    const lifecycle = requestLifecycle(request);

    try {
      return await this.orchestrator.execute({
        operation: TASK2_OPERATION,
        input,
        ...requestMetadata(request, lifecycle),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(backgroundLifecycle === undefined ? {} : { backgroundLifecycle }),
      });
    } finally {
      lifecycle.dispose();
    }
  }
}
