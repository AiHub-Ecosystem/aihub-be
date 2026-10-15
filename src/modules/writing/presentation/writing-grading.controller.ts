import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import { userIdentityRequired } from '@/common/errors/user-identity-required';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type RequestLifecycleState,
  getRequestLifecycle,
} from '@/common/http/request-lifecycle.hook';
import { markRequestAdmission } from '@/common/http/request-timing.hook';
import {
  type GradeResponse,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
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
import { getMeteringEvidence } from '@/modules/metering/application/metering-evidence';
import {
  METERING_FINALIZER,
  type MeteringFinalizerPort,
} from '@/modules/metering/application/metering-finalizer.port';
import { billBackgroundCompletion } from '@/modules/metering/public/background-completion-billing';
import { isAllowedTask1ImageUrl } from '@/modules/writing/application/task1-image-url.policy';

const TASK1_OPERATION = 'writing.task1.grade' as const;
const TASK2_OPERATION = 'writing.task2.grade' as const;

// Body size is enforced earlier, before parsing, by the `onRequest` hook
// registered in main.ts (see `registerBodySizeGuard`) — a body that reaches
// here has already passed that check.
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

/**
 * The concurrency permit's lifecycle, plus the one charge for a grading that
 * completes after its `504` (ADR-0097).
 */
function backgroundLifecycleFor(
  request: AuthenticatedRequest,
  lifecycle: RequestLifecycleState,
  finalizer: MeteringFinalizerPort,
) {
  const concurrency = getConcurrencyBackgroundLifecycle(request);
  return billBackgroundCompletion({
    requestId: String(request.id),
    receivedAt: lifecycle.receivedAt,
    evidence: getMeteringEvidence(request),
    finalizer,
    ...(concurrency === undefined ? {} : { inner: concurrency }),
  });
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
    onDispatchStart: () => markRequestAdmission(request.raw),
    organizationId: authenticated.organizationId,
    apiKeyId: authenticated.apiKeyId,
    environment: authenticated.environment,
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
    @Inject(METERING_FINALIZER)
    private readonly finalizer: MeteringFinalizerPort,
  ) {}

  @Post(OPERATION_CATALOG[TASK1_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK1_OPERATION)
  async gradeTask1(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    const input = parseRequestBody(GradeTask1RequestSchema, body);
    if (!isAllowedTask1ImageUrl(input.image_url)) {
      throw invalidRequest();
    }

    const idempotencyKey = resolveIdempotencyKey(
      TASK1_OPERATION,
      request.headers['idempotency-key'],
    );
    const lifecycle = requestLifecycle(request);
    const backgroundLifecycle = backgroundLifecycleFor(
      request,
      lifecycle,
      this.finalizer,
    );

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
    const input = parseRequestBody(GradeTask2RequestSchema, body);
    const idempotencyKey = resolveIdempotencyKey(
      TASK2_OPERATION,
      request.headers['idempotency-key'],
    );
    const lifecycle = requestLifecycle(request);
    const backgroundLifecycle = backgroundLifecycleFor(
      request,
      lifecycle,
      this.finalizer,
    );

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
