import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type GradeResponse,
  GradeTask1RequestSchema,
  GradeTask2RequestSchema,
} from '@/contracts/writing/grading';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_REQUEST_EXECUTOR,
  type GradedRequestExecutorPort,
} from '@/modules/gateway/public/graded-request-executor';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { isAllowedTask1ImageUrl } from '@/modules/writing/application/task1-image-url.policy';

const TASK1_OPERATION = 'writing.task1.grade' as const;
const TASK2_OPERATION = 'writing.task2.grade' as const;

/**
 * Both grading operations return the same response shape and share guard and
 * interceptor wiring, so they stay in one controller.
 */
@Controller()
@GradedRequest()
export class WritingGradingController {
  constructor(
    @Inject(GRADED_REQUEST_EXECUTOR)
    private readonly gradedRequest: GradedRequestExecutorPort,
  ) {}

  @Post(OPERATION_CATALOG[TASK1_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK1_OPERATION)
  async gradeTask1(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    return this.gradedRequest.execute(request, TASK1_OPERATION, () => {
      const input = parseRequestBody(GradeTask1RequestSchema, body, request);
      if (!isAllowedTask1ImageUrl(input.image_url)) {
        throw invalidRequest();
      }
      return { input };
    });
  }

  @Post(OPERATION_CATALOG[TASK2_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK2_OPERATION)
  async gradeTask2(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<GradeResponse>> {
    return this.gradedRequest.execute(request, TASK2_OPERATION, () => ({
      input: parseRequestBody(GradeTask2RequestSchema, body, request),
    }));
  }
}
