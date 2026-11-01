import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Static } from '@sinclair/typebox';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError } from '@/common/errors/app-error';
import { parseRequestBody } from '@/common/http/parse-request-body';
import { parseRequestParams } from '@/common/http/parse-request-params';
import type { SpeakingV2PartResult } from '@/contracts/speaking/v2/part-result';
import type { SpeakingV2QuestionResult } from '@/contracts/speaking/v2/question-result';
import {
  SpeakingV2PartGradeRequestSchema,
  SpeakingV2PartPathSchema,
  SpeakingV2ResponsePathSchema,
  SpeakingV2TestGradeRequestSchema,
  SpeakingV2TestPathSchema,
} from '@/contracts/speaking/v2/requests';
import type { SpeakingV2TestResult } from '@/contracts/speaking/v2/test-result';
import type { DispatchResult } from '@/modules/gateway/application/operation-dispatcher.port';
import { GradedRequest } from '@/modules/gateway/presentation/graded-request.decorator';
import {
  GRADED_REQUEST_EXECUTOR,
  type GradedRequestExecutorPort,
} from '@/modules/gateway/public/graded-request-executor';
import {
  type AuthenticatedRequest,
  getAuthenticatedApiKey,
} from '@/modules/identity/shared/presentation/authenticated-request';
import { RequireOperation } from '@/modules/identity/shared/presentation/require-operation.decorator';
import { getMeteringEvidence } from '@/modules/metering/public/metering-evidence';
import { requireOwnedSpeakingResults } from '@/modules/speaking/application/require-owned-speaking-results';
import {
  SPEAKING_MULTIPART_PARSER,
  type SpeakingMultipartParserPort,
} from '@/modules/speaking/application/speaking-multipart-parser.port';
import {
  type InFlightCeiling,
  SPEAKING_UPLOAD_CEILING,
} from '@/modules/speaking/application/speaking-upload-ceiling';
import {
  SPEAKING_V2_RESULT_OWNERSHIP,
  type SpeakingV2ResultKind,
  type SpeakingV2ResultOwner,
  type SpeakingV2ResultOwnershipPort,
} from '@/modules/speaking/application/speaking-v2-result-ownership.port';
import { createFastifySpeakingMultipartSource } from './fastify-speaking-multipart.source';

const QUESTION_GRADING = 'speaking.v2.question-grading' as const;
const PART_GRADING = 'speaking.v2.part-grading' as const;
const TEST_GRADING = 'speaking.v2.test-grading' as const;
const RESPONSE_GET = 'speaking.v2.response-get' as const;
const PART_GET = 'speaking.v2.part-get' as const;
const TEST_GET = 'speaking.v2.test-get' as const;

/** The catalog writes a path parameter as `{name}`; Fastify wants `:name`. */
function routePath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, ':$1');
}

@Controller()
@GradedRequest()
export class SpeakingV2Controller {
  constructor(
    @Inject(GRADED_REQUEST_EXECUTOR)
    private readonly gradedRequest: GradedRequestExecutorPort,
    @Inject(SPEAKING_MULTIPART_PARSER)
    private readonly multipartParser: SpeakingMultipartParserPort,
    @Inject(SPEAKING_UPLOAD_CEILING)
    private readonly uploadCeiling: InFlightCeiling,
    @Inject(SPEAKING_V2_RESULT_OWNERSHIP)
    private readonly resultOwnership: SpeakingV2ResultOwnershipPort,
  ) {}

  private owner(request: AuthenticatedRequest): SpeakingV2ResultOwner {
    const userId = request.aihubIdentity?.userId;
    if (userId === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        message: 'Speaking result ownership unavailable',
        retryable: false,
      });
    }
    const auth = getAuthenticatedApiKey(request);
    return {
      organizationId: auth.organizationId,
      environment: auth.environment,
      endUserId: userId,
    };
  }

  private async requireOwned(
    request: AuthenticatedRequest,
    kind: SpeakingV2ResultKind,
    ids: readonly string[],
  ): Promise<void> {
    await requireOwnedSpeakingResults(
      this.resultOwnership,
      this.owner(request),
      kind,
      ids,
    );
  }

  private async recordSuccessful(
    request: AuthenticatedRequest,
    owner: SpeakingV2ResultOwner,
    kind: SpeakingV2ResultKind,
    id: string,
  ): Promise<void> {
    try {
      await this.resultOwnership.record(owner, kind, id);
    } catch (error) {
      const evidence = getMeteringEvidence(request);
      if (evidence !== undefined) evidence.settled = true;
      throw error;
    }
  }

  @Post(routePath(OPERATION_CATALOG[QUESTION_GRADING].path))
  @HttpCode(200)
  @RequireOperation(QUESTION_GRADING)
  async gradeQuestion(
    @Req() request: AuthenticatedRequest,
  ): Promise<DispatchResult<SpeakingV2QuestionResult>> {
    let partResultId: string | undefined;
    const result = await this.gradedRequest.execute(
      request,
      QUESTION_GRADING,
      async (signal) => {
        // Acquire before reading the body, so a refused upload never buffers audio.
        const release = this.uploadCeiling.enter();
        try {
          const source = createFastifySpeakingMultipartSource(request);
          const input = await this.multipartParser.parseQuestionV2(
            source,
            signal,
          );
          partResultId = input.partResultId;
          return { input, release };
        } catch (error) {
          release();
          throw error;
        }
      },
    );
    const owner = this.owner(request);
    await this.recordSuccessful(
      request,
      owner,
      'response',
      result.data.meta.response_id,
    );
    if (partResultId !== undefined) {
      await this.recordSuccessful(request, owner, 'part', partResultId);
    }
    return result;
  }

  @Post(routePath(OPERATION_CATALOG[PART_GRADING].path))
  @HttpCode(200)
  @RequireOperation(PART_GRADING)
  async gradePart(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<SpeakingV2PartResult>> {
    let input: Static<typeof SpeakingV2PartGradeRequestSchema> | undefined;
    const result = await this.gradedRequest.execute(
      request,
      PART_GRADING,
      async () => {
        input = parseRequestBody(
          SpeakingV2PartGradeRequestSchema,
          body,
          request,
        );
        if (input.response_ids !== undefined) {
          await this.requireOwned(request, 'response', input.response_ids);
        }
        return { input };
      },
    );
    if (input === undefined)
      throw new Error('Speaking Part input was not prepared');
    const owner = this.owner(request);
    await this.recordSuccessful(request, owner, 'part', input.part_result_id);
    if (input.test_id !== undefined) {
      await this.recordSuccessful(request, owner, 'test', input.test_id);
    }
    return result;
  }

  @Post(routePath(OPERATION_CATALOG[TEST_GRADING].path))
  @HttpCode(200)
  @RequireOperation(TEST_GRADING)
  async gradeTest(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DispatchResult<SpeakingV2TestResult>> {
    let input: Static<typeof SpeakingV2TestGradeRequestSchema> | undefined;
    const result = await this.gradedRequest.execute(
      request,
      TEST_GRADING,
      async () => {
        input = parseRequestBody(
          SpeakingV2TestGradeRequestSchema,
          body,
          request,
        );
        if (input.response_ids !== undefined) {
          await this.requireOwned(request, 'response', input.response_ids);
        }
        if (input.part_result_ids !== undefined) {
          await this.requireOwned(request, 'part', input.part_result_ids);
        }
        return { input };
      },
    );
    if (input === undefined)
      throw new Error('Speaking Test input was not prepared');
    await this.recordSuccessful(
      request,
      this.owner(request),
      'test',
      input.test_id,
    );
    return result;
  }

  @Get(routePath(OPERATION_CATALOG[RESPONSE_GET].path))
  @RequireOperation(RESPONSE_GET)
  async getResponse(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2QuestionResult>> {
    return this.gradedRequest.execute(request, RESPONSE_GET, async () => {
      const input = parseRequestParams(SpeakingV2ResponsePathSchema, params);
      await this.requireOwned(request, 'response', [input.response_id]);
      return { input };
    });
  }

  @Get(routePath(OPERATION_CATALOG[PART_GET].path))
  @RequireOperation(PART_GET)
  async getPart(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2PartResult>> {
    return this.gradedRequest.execute(request, PART_GET, async () => {
      const input = parseRequestParams(SpeakingV2PartPathSchema, params);
      await this.requireOwned(request, 'part', [input.part_result_id]);
      return { input };
    });
  }

  @Get(routePath(OPERATION_CATALOG[TEST_GET].path))
  @RequireOperation(TEST_GET)
  async getTest(
    @Req() request: AuthenticatedRequest,
    @Param() params: unknown,
  ): Promise<DispatchResult<SpeakingV2TestResult>> {
    return this.gradedRequest.execute(request, TEST_GET, async () => {
      const input = parseRequestParams(SpeakingV2TestPathSchema, params);
      await this.requireOwned(request, 'test', [input.test_id]);
      return { input };
    });
  }
}
