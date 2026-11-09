import { type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { isRecord } from '@/common/is-record';
import type { RequestContext } from '@/common/request-context/request-context';
import {
  type CreateLongWritingExerciseRequest,
  type CreateMicroExerciseRequest,
  type GradeMicroExerciseRequest,
  type LongWritingExerciseResponse,
  LongWritingExerciseResponseSchema,
  MICRO_EXERCISE_RESPONSE_SCHEMAS,
  type MicroExerciseGradeResponse,
  MicroExerciseGradeResponseSchema,
  type MicroExerciseResponse,
} from '@/contracts/writing/v2/exercises';
import { contractViolation } from '@/downstream/contract-violation';
import type { DownstreamAdapter } from '@/downstream/downstream-adapter';
import type {
  DownstreamErrorHint,
  DownstreamRequest,
} from '@/downstream/downstream.types';
import { requiredSpeakingIdentityHeaders } from '@/downstream/speaking/speaking-grading.adapter';

function jsonRequest(
  path: string,
  context: RequestContext,
  body: Record<string, unknown>,
): DownstreamRequest {
  return {
    method: 'POST',
    path,
    headers: requiredSpeakingIdentityHeaders(context),
    body,
    contentType: 'application/json',
  };
}

function providerCriterion(criterion: string): string {
  return criterion === 'grammatical_range_accuracy'
    ? 'grammar_range_accuracy'
    : criterion;
}

function providerReference(error: {
  readonly prompt: string;
  readonly question_type: string;
  readonly image_url?: string | null;
  readonly comments: readonly {
    readonly quote: string;
    readonly explanation: string;
  }[];
}) {
  return {
    question: {
      prompt: error.prompt,
      image: error.image_url ?? null,
      question_type: error.question_type,
    },
    comments: error.comments,
  };
}

function parseData<T extends TSchema>(schema: T, body: unknown): Static<T> {
  if (!isRecord(body) || body['success'] !== true || !isRecord(body['data'])) {
    throw contractViolation('response is missing a successful data object');
  }
  const data = Value.Clean(schema, body['data']);
  if (!Value.Check(schema, data)) {
    const firstError = Value.Errors(schema, data).First();
    throw contractViolation(
      `response data does not match the captured shape at ${firstError?.path ?? '/'}`,
    );
  }
  return data as Static<T>;
}

function requireQuestionCount(data: {
  readonly meta: { readonly number_of_questions: number };
  readonly exercise: readonly unknown[];
}): void {
  if (data.meta.number_of_questions !== data.exercise.length) {
    throw contractViolation(
      'exercise count does not match meta.number_of_questions',
    );
  }
}

function parseMicroExerciseResponse(body: unknown): MicroExerciseResponse {
  const rawData = isRecord(body) ? body['data'] : undefined;
  const rawMeta = isRecord(rawData) ? rawData['meta'] : undefined;
  if (
    !isRecord(rawMeta) ||
    typeof rawMeta['type'] !== 'string' ||
    !Object.hasOwn(MICRO_EXERCISE_RESPONSE_SCHEMAS, rawMeta['type'])
  ) {
    throw contractViolation('response has an unknown micro exercise type');
  }
  const schema =
    MICRO_EXERCISE_RESPONSE_SCHEMAS[
      rawMeta['type'] as keyof typeof MICRO_EXERCISE_RESPONSE_SCHEMAS
    ];
  const data = parseData(schema, body);
  requireQuestionCount(data);
  return data as MicroExerciseResponse;
}

function parseLongWritingExerciseResponse(
  body: unknown,
): LongWritingExerciseResponse {
  const data = parseData(LongWritingExerciseResponseSchema, body);
  requireQuestionCount(data);
  return data;
}

function parseWritingExerciseError(
  status: number,
  body: unknown,
): DownstreamErrorHint | undefined {
  if (status === 504) {
    return {
      code: 'AI_SERVICE_TIMEOUT',
      message: 'AI service request timed out',
      retryable: true,
    };
  }
  return status === 400 &&
    isRecord(body) &&
    body['error_code'] === 'invalid_request'
    ? {
        code: 'INVALID_REQUEST',
        message: 'Writing exercise request was refused by the AI service',
        retryable: false,
      }
    : undefined;
}

export const createMicroExerciseAdapter: DownstreamAdapter<
  CreateMicroExerciseRequest,
  MicroExerciseResponse
> = {
  operation: 'writing.v2.micro-exercises.create',
  downstream: 'ai-writing',

  buildRequest(input, context): DownstreamRequest {
    return jsonRequest(
      OPERATION_CATALOG['writing.v2.micro-exercises.create'].downstreamPath,
      context,
      {
        topic: input.topic,
        writing_task: input.writing_task,
        criterion: providerCriterion(input.criterion),
        error_code: input.error_code,
        ...(input.exercise_type == null
          ? {}
          : { exercise_type: input.exercise_type }),
        references: [providerReference(input)],
      },
    );
  },

  parseResponse: (response) => parseMicroExerciseResponse(response.body),
  parseError: parseWritingExerciseError,
};

export const createLongWritingExerciseAdapter: DownstreamAdapter<
  CreateLongWritingExerciseRequest,
  LongWritingExerciseResponse
> = {
  operation: 'writing.v2.long-writing-exercises.create',
  downstream: 'ai-writing',

  buildRequest(input, context): DownstreamRequest {
    return jsonRequest(
      OPERATION_CATALOG['writing.v2.long-writing-exercises.create']
        .downstreamPath,
      context,
      {
        topic: input.topic,
        writing_task: input.writing_task,
        errors: input.errors.map((error, index) => ({
          error_no: index + 1,
          criterion: providerCriterion(error.criterion),
          error_code: error.error_code,
          references: [providerReference(error)],
        })),
      },
    );
  },

  parseResponse: (response) => parseLongWritingExerciseResponse(response.body),
  parseError: parseWritingExerciseError,
};

export const gradeMicroExerciseAdapter: DownstreamAdapter<
  GradeMicroExerciseRequest,
  MicroExerciseGradeResponse
> = {
  operation: 'writing.v2.micro-exercises.grade',
  downstream: 'ai-writing',

  buildRequest(input, context): DownstreamRequest {
    const {
      instruction,
      question_no,
      question_text,
      question_image,
      hint,
      sample_answer,
      ai_grading_rubric,
      note,
      user_answer,
    } = input;
    return jsonRequest(
      OPERATION_CATALOG['writing.v2.micro-exercises.grade'].downstreamPath,
      context,
      {
        instruction,
        question_no,
        question_text,
        question_image,
        hint,
        sample_answer,
        ai_grading_rubric,
        note: note ?? null,
        user_answer,
      },
    );
  },

  parseResponse: (response) =>
    parseData(MicroExerciseGradeResponseSchema, response.body),
  parseError: parseWritingExerciseError,
};
