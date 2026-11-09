import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { invalidRequest } from '@/common/errors/invalid-request';
import { parseRequestBody } from '@/common/http/parse-request-body';
import {
  type WritingV2GradeResponse,
  WritingV2GradeTask1RequestSchema,
  WritingV2GradeTask2RequestSchema,
} from '@/contracts/writing/v2/grading';
import type { DispatchResult } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
  createGradedPipelineContext,
} from '@/modules/gateway/public/graded-pipeline';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { isWithinEssayWordLimit } from '@/modules/writing/grading/domain/essay-word-limit.policy';
import { isAllowedTask1ImageUrl } from '@/modules/writing/grading/domain/task1-image-url.policy';

const TASK1_OPERATION = 'writing.v2.task1.grade' as const;
const TASK2_OPERATION = 'writing.v2.task2.grade' as const;

/**
 * Its own controller because the /v2 contract differs from /v1
 * (ADR-0138 decision 2, ADR-0143 decision 4). The two tasks share one response
 * shape and the graded-request wiring, so they stay together.
 */
@Controller()
@GradedRequest()
export class WritingV2GradingController {
  constructor(
    @Inject(GRADED_PIPELINE_ENGINE)
    private readonly gradedRequest: GradedPipelineEnginePort,
  ) {}

  @Post(OPERATION_CATALOG[TASK1_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK1_OPERATION)
  async gradeTask1(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<WritingV2GradeResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, TASK1_OPERATION, () => {
        const input = parseRequestBody(
          WritingV2GradeTask1RequestSchema,
          body,
          request,
        );
        if (
          !isAllowedTask1ImageUrl(input.image_url) ||
          !isWithinEssayWordLimit(input.essay)
        ) {
          throw invalidRequest();
        }
        return { input };
      }),
    );
  }

  @Post(OPERATION_CATALOG[TASK2_OPERATION].path)
  @HttpCode(200)
  @RequireOperation(TASK2_OPERATION)
  async gradeTask2(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<WritingV2GradeResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, TASK2_OPERATION, () => {
        const input = parseRequestBody(
          WritingV2GradeTask2RequestSchema,
          body,
          request,
        );
        if (!isWithinEssayWordLimit(input.essay)) {
          throw invalidRequest();
        }
        return { input };
      }),
    );
  }
}
