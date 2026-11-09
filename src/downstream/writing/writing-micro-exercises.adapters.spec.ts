import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Value } from '@sinclair/typebox/value';

import { createRequestContext } from '@/common/request-context/request-context.factory';
import {
  type CreateLongWritingExerciseRequest,
  type CreateMicroExerciseRequest,
  type GradeMicroExerciseRequest,
  LongWritingExerciseResponseSchema,
  MicroExerciseGradeResponseSchema,
  MicroExerciseResponseSchema,
} from '@/contracts/writing/v2/exercises';
import {
  createLongWritingExerciseAdapter,
  createMicroExerciseAdapter,
  gradeMicroExerciseAdapter,
} from './writing-micro-exercises.adapters';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), `test/fixtures/ai-writing/${name}`),
      'utf8',
    ),
  );
}

function fixtureRecord(name: string): Record<string, unknown> {
  const parsed = fixture(name);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('fixture is not an object');
  }
  return parsed as Record<string, unknown>;
}

interface CapturedReference {
  readonly question: {
    readonly prompt: string;
    readonly image: string | null;
    readonly question_type: string;
  };
  readonly comments: readonly {
    readonly quote: string;
    readonly explanation: string;
  }[];
}

interface CapturedMicroRequest {
  readonly topic: string;
  readonly writing_task: 1 | 2;
  readonly criterion: string;
  readonly error_code: string;
  readonly exercise_type: string;
  readonly references: readonly CapturedReference[];
}

function microInput(name: string): CreateMicroExerciseRequest {
  const captured = fixtureRecord(name) as unknown as CapturedMicroRequest;
  const reference = captured.references[0];
  if (reference === undefined) throw new Error('fixture has no reference');
  return {
    topic: captured.topic,
    writing_task: captured.writing_task,
    criterion:
      captured.criterion === 'grammar_range_accuracy'
        ? 'grammatical_range_accuracy'
        : (captured.criterion as CreateMicroExerciseRequest['criterion']),
    error_code: captured.error_code,
    exercise_type: captured.exercise_type as Exclude<
      CreateMicroExerciseRequest['exercise_type'],
      undefined
    >,
    prompt: reference.question.prompt,
    question_type: reference.question.question_type,
    image_url: reference.question.image,
    comments: reference.comments.map(({ quote, explanation }) => ({
      quote,
      explanation,
    })),
  };
}

interface CapturedLongError {
  readonly criterion: string;
  readonly error_code: string;
  readonly error_no: number;
  readonly references: readonly CapturedReference[];
}

interface CapturedLongRequest {
  readonly topic: string;
  readonly writing_task: 1 | 2;
  readonly errors: readonly CapturedLongError[];
}

const context = createRequestContext({
  requestId: 'req_01J8QK3M7XW2P5NRTVA9BCDEFG',
  receivedAt: new Date('2026-11-01T00:00:00.000Z'),
  deadlineMs: 45_000,
  organizationId: 'org_acme',
  apiKeyId: 'ak-dev',
  userId: 'learner_42',
  identityMode: 'signed_assertion',
  scopes: ['writing.exercise'],
});

const IDENTITY_HEADERS = {
  'x-aihub-organization-id': 'org_acme',
  'x-aihub-user-id': 'learner_42',
  'x-aihub-user-identity-mode': 'signed_assertion',
};

function providerResponse(name: string) {
  return {
    status: 200,
    headers: {},
    body: fixture(name),
  };
}

function providerErrorSample(name: string) {
  const sample = fixtureRecord(name);
  if (typeof sample['status'] !== 'number' || !Object.hasOwn(sample, 'body')) {
    throw new Error('provider error sample is incomplete');
  }
  return { status: sample['status'], body: sample['body'] };
}

const exerciseAdapters = [
  ['micro creation', createMicroExerciseAdapter],
  ['long-writing creation', createLongWritingExerciseAdapter],
  ['micro grading', gradeMicroExerciseAdapter],
] as const;

describe('createMicroExerciseAdapter', () => {
  it.each([
    'micro-multiple_choice_single.request.json',
    'micro-multiple_choice_multiple.request.json',
    'micro-choose_from_list.request.json',
    'micro-gap_filling.request.json',
    'micro-annotation.request.json',
    'micro-reorder.request.json',
    'micro-short_writing.request.json',
  ])('maps public fields to the captured provider request %s', (name) => {
    const input = microInput(name);
    const request = createMicroExerciseAdapter.buildRequest(input, context);

    expect(request).toEqual({
      method: 'POST',
      path: '/v2/create-micro-exercise',
      headers: IDENTITY_HEADERS,
      body: fixtureRecord(name),
      contentType: 'application/json',
    });
  });

  it('maps grammatical_range_accuracy and omits a null exercise type', () => {
    const input = microInput('micro-short_writing.request.json');
    const request = createMicroExerciseAdapter.buildRequest(
      { ...input, exercise_type: null },
      context,
    );
    const body = request.body as Record<string, unknown>;

    expect(body['criterion']).toBe('grammar_range_accuracy');
    expect(body).not.toHaveProperty('exercise_type');
  });

  it.each([
    ['multiple_choice_single', 'micro-multiple_choice_single.response.json'],
    [
      'multiple_choice_multiple',
      'micro-multiple_choice_multiple.response.json',
    ],
    ['choose_from_list', 'micro-choose_from_list.response.json'],
    ['gap_filling', 'micro-gap_filling.response.json'],
    ['annotation', 'micro-annotation.response.json'],
    ['reorder', 'micro-reorder.response.json'],
    ['short_writing', 'micro-short_writing.response.json'],
  ])('parses the captured %s response into the public schema', (type, name) => {
    const result = createMicroExerciseAdapter.parseResponse(
      providerResponse(name),
    );

    expect(Value.Check(MicroExerciseResponseSchema, result)).toBe(true);
    expect(result.meta.type).toBe(type);
    expect(JSON.stringify(result)).not.toMatch(/"(usage|metrics|message)"/);
  });

  it('removes provider-only additions from the public response', () => {
    const response = fixtureRecord('micro-gap_filling.response.json');
    const data = response['data'] as Record<string, unknown>;
    const meta = data['meta'] as Record<string, unknown>;
    const sanitized = createMicroExerciseAdapter.parseResponse({
      status: 200,
      headers: {},
      body: {
        ...response,
        data: {
          ...data,
          provider_private: 'discard',
          meta: { ...meta, provider_private: 'discard' },
          exercise: (data['exercise'] as Record<string, unknown>[]).map(
            (row) => ({
              ...row,
              provider_private: 'discard',
            }),
          ),
        },
      },
    });

    expect(sanitized).not.toHaveProperty('provider_private');
    expect(sanitized.meta).not.toHaveProperty('provider_private');
    expect(sanitized.exercise[0]).not.toHaveProperty('provider_private');
  });

  it('maps the captured invalid_request response to a safe public error', () => {
    expect(
      createMicroExerciseAdapter.parseError?.(
        400,
        fixture('micro-invalid-error-code.response.json'),
      ),
    ).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
  });
});

describe('createLongWritingExerciseAdapter', () => {
  it('maps each selected error to a numbered provider reference', () => {
    const captured = fixtureRecord(
      'longwriting.request.json',
    ) as unknown as CapturedLongRequest;
    const input: CreateLongWritingExerciseRequest = {
      topic: captured.topic,
      writing_task: captured.writing_task,
      errors: captured.errors.map((error) => {
        const reference = error.references?.[0];
        if (reference === undefined)
          throw new Error('fixture has no reference');
        return {
          criterion:
            error.criterion === 'grammar_range_accuracy'
              ? 'grammatical_range_accuracy'
              : (error.criterion as CreateLongWritingExerciseRequest['errors'][number]['criterion']),
          error_code: error.error_code,
          prompt: reference.question.prompt,
          question_type: reference.question.question_type,
          image_url: reference.question.image,
          comments: reference.comments.map(({ quote, explanation }) => ({
            quote,
            explanation,
          })),
        };
      }),
    };

    expect(
      createLongWritingExerciseAdapter.buildRequest(input, context),
    ).toEqual({
      method: 'POST',
      path: '/v2/create-longwriting-exercise',
      headers: IDENTITY_HEADERS,
      body: fixtureRecord('longwriting.request.json'),
      contentType: 'application/json',
    });
  });

  it('parses the captured long-writing response and omits provider telemetry', () => {
    const result = createLongWritingExerciseAdapter.parseResponse(
      providerResponse('longwriting.response.json'),
    );

    expect(Value.Check(LongWritingExerciseResponseSchema, result)).toBe(true);
    expect(result.meta.type).toBe('long_writing');
    expect(JSON.stringify(result)).not.toMatch(/"(usage|metrics|message)"/);
  });
});

describe('gradeMicroExerciseAdapter', () => {
  it.each([
    ['short_writing', 'micro-grade-short-writing'],
    ['long_writing', 'micro-grade-long-writing'],
  ] as const)(
    'posts captured %s fields without the local type field',
    (type, name) => {
      const input = {
        ...fixtureRecord(`${name}.request.json`),
        exercise_type: type,
      } as unknown as GradeMicroExerciseRequest;
      const request = gradeMicroExerciseAdapter.buildRequest(input, context);

      expect(request).toEqual({
        method: 'POST',
        path: '/v2/grading-micro-exercise',
        headers: IDENTITY_HEADERS,
        body: fixtureRecord(`${name}.request.json`),
        contentType: 'application/json',
      });
    },
  );

  it.each(['short', 'long'])(
    'parses captured %s-writing grade output',
    (type) => {
      const result = gradeMicroExerciseAdapter.parseResponse(
        providerResponse(`micro-grade-${type}-writing.response.json`),
      );

      expect(Value.Check(MicroExerciseGradeResponseSchema, result)).toBe(true);
      expect(Object.keys(result).sort()).toEqual(['comment', 'score']);
    },
  );
});

describe('provider-confirmed Writing exercise failures', () => {
  it.each(exerciseAdapters)(
    'maps the provider timeout to AI_SERVICE_TIMEOUT for %s',
    (_operation, adapter) => {
      const sample = providerErrorSample('provider-error-timeout.sample.json');

      expect(adapter.parseError?.(sample.status, sample.body)).toEqual({
        code: 'AI_SERVICE_TIMEOUT',
        message: 'AI service request timed out',
        retryable: true,
      });
    },
  );

  it.each([
    ['throttling', 'provider-error-rate-limited.sample.json'],
    ['internal failure', 'provider-error-internal-error.sample.json'],
  ])('leaves provider %s to the shared status mapping', (_kind, name) => {
    const sample = providerErrorSample(name);

    for (const [, adapter] of exerciseAdapters) {
      expect(adapter.parseError?.(sample.status, sample.body)).toBeUndefined();
    }
  });
});

describe('provider-confirmed soft-failure fallbacks', () => {
  it.each([
    [
      'empty micro exercise',
      createMicroExerciseAdapter,
      'micro-annotation-empty.response.json',
    ],
    [
      'empty long-writing exercise',
      createLongWritingExerciseAdapter,
      'provider-fallback-longwriting.response.json',
    ],
    [
      'empty micro grade',
      gradeMicroExerciseAdapter,
      'provider-fallback-micro-grade.response.json',
    ],
  ] as const)(
    '%s is rejected as a provider contract violation',
    (_kind, adapter, name) => {
      let error: unknown;
      try {
        adapter.parseResponse(providerResponse(name));
      } catch (caught) {
        error = caught;
      }

      expect(error).toMatchObject({ code: 'AI_SERVICE_CONTRACT_VIOLATION' });
      if (!(error instanceof Error)) {
        throw new Error('expected a contract violation error');
      }
      expect(error.message).not.toContain('Lỗi parse JSON');
    },
  );
});
