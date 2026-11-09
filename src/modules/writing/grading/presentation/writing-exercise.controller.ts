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
  CreateLongWritingExerciseRequestSchema,
  CreateMicroExerciseRequestSchema,
  GradeMicroExerciseRequestSchema,
  type LongWritingExerciseResponse,
  type MicroExerciseGradeResponse,
  type MicroExerciseResponse,
} from '@/contracts/writing/v2/exercises';
import type { DispatchResult } from '@/modules/gateway/application/dispatch/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_PIPELINE_ENGINE,
  type GradedPipelineEnginePort,
  createGradedPipelineContext,
} from '@/modules/gateway/public/graded-pipeline';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  isValidWritingExerciseError,
  isValidWritingExerciseImage,
} from '@/modules/writing/grading/domain/writing-exercise-request.policy';

const MICRO_CREATE = 'writing.v2.micro-exercises.create' as const;
const LONG_CREATE = 'writing.v2.long-writing-exercises.create' as const;
const MICRO_GRADE = 'writing.v2.micro-exercises.grade' as const;

@Controller()
@GradedRequest()
export class WritingExerciseController {
  constructor(
    @Inject(GRADED_PIPELINE_ENGINE)
    private readonly gradedRequest: GradedPipelineEnginePort,
  ) {}

  @Post(OPERATION_CATALOG[MICRO_CREATE].path)
  @HttpCode(200)
  @RequireOperation(MICRO_CREATE)
  async createMicro(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<MicroExerciseResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, MICRO_CREATE, () => {
        const input = parseRequestBody(
          CreateMicroExerciseRequestSchema,
          body,
          request,
        );
        if (!isValidWritingExerciseError(input.writing_task, input)) {
          throw invalidRequest();
        }
        return { input };
      }),
    );
  }

  @Post(OPERATION_CATALOG[LONG_CREATE].path)
  @HttpCode(200)
  @RequireOperation(LONG_CREATE)
  async createLongWriting(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<LongWritingExerciseResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, LONG_CREATE, () => {
        const input = parseRequestBody(
          CreateLongWritingExerciseRequestSchema,
          body,
          request,
        );
        if (
          input.errors.some(
            (error) => !isValidWritingExerciseError(input.writing_task, error),
          )
        ) {
          throw invalidRequest();
        }
        return { input };
      }),
    );
  }

  @Post(OPERATION_CATALOG[MICRO_GRADE].path)
  @HttpCode(200)
  @RequireOperation(MICRO_GRADE)
  async gradeMicro(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<DispatchResult<MicroExerciseGradeResponse>> {
    return this.gradedRequest.execute(
      createGradedPipelineContext(request, reply, MICRO_GRADE, () => {
        const input = parseRequestBody(
          GradeMicroExerciseRequestSchema,
          body,
          request,
        );
        if (!isValidWritingExerciseImage(input.question_image)) {
          throw invalidRequest();
        }
        return { input };
      }),
    );
  }
}
