import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';

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
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_REQUEST_EXECUTOR,
  type GradedRequestExecutorPort,
} from '@/modules/gateway/public/graded-request-executor';
import type { AuthenticatedRequest } from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import {
  isValidWritingExerciseError,
  isValidWritingExerciseImage,
} from '@/modules/writing/application/writing-exercise-request.policy';

const MICRO_CREATE = 'writing.v2.micro-exercises.create' as const;
const LONG_CREATE = 'writing.v2.long-writing-exercises.create' as const;
const MICRO_GRADE = 'writing.v2.micro-exercises.grade' as const;

@Controller()
@GradedRequest()
export class WritingExerciseController {
  constructor(
    @Inject(GRADED_REQUEST_EXECUTOR)
    private readonly gradedRequest: GradedRequestExecutorPort,
  ) {}

  @Post(OPERATION_CATALOG[MICRO_CREATE].path)
  @HttpCode(200)
  @RequireOperation(MICRO_CREATE)
  async createMicro(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<MicroExerciseResponse>> {
    return this.gradedRequest.execute(request, MICRO_CREATE, () => {
      const input = parseRequestBody(
        CreateMicroExerciseRequestSchema,
        body,
        request,
      );
      if (!isValidWritingExerciseError(input.writing_task, input)) {
        throw invalidRequest();
      }
      return { input };
    });
  }

  @Post(OPERATION_CATALOG[LONG_CREATE].path)
  @HttpCode(200)
  @RequireOperation(LONG_CREATE)
  async createLongWriting(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<LongWritingExerciseResponse>> {
    return this.gradedRequest.execute(request, LONG_CREATE, () => {
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
    });
  }

  @Post(OPERATION_CATALOG[MICRO_GRADE].path)
  @HttpCode(200)
  @RequireOperation(MICRO_GRADE)
  async gradeMicro(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<MicroExerciseGradeResponse>> {
    return this.gradedRequest.execute(request, MICRO_GRADE, () => {
      const input = parseRequestBody(
        GradeMicroExerciseRequestSchema,
        body,
        request,
      );
      if (!isValidWritingExerciseImage(input.question_image)) {
        throw invalidRequest();
      }
      return { input };
    });
  }
}
