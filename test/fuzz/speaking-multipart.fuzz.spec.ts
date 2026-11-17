import { Value } from '@sinclair/typebox/value';
import {
  array,
  asyncProperty,
  constantFrom,
  integer,
  oneof,
  string,
  tuple,
  uint8Array,
} from 'fast-check';

import { AppError } from '@/common/errors/app-error';
import { SpeakingGradeRequestSchema } from '@/contracts/speaking/grading';
import { SpeakingV2QuestionGradeRequestSchema } from '@/contracts/speaking/v2/requests';
import type {
  SpeakingMultipartPart,
  SpeakingMultipartSource,
} from '@/modules/speaking/application/audio/speaking-multipart-parser.port';
import { FastifySpeakingMultipartParser } from '@/modules/speaking/public/fastify-speaking-multipart.parser';

import { assertWithReproducer } from './assert-with-reproducer';
import seeds from './seeds.json';

const fieldName = oneof(
  constantFrom(
    'part',
    'question_id',
    'prompt_text',
    'test_type',
    'test_code',
    'transcript',
    'part_result_id',
  ),
  string({ maxLength: 24 }).map((name) => `caller-field-${name}`),
);
const fieldValue = string({ maxLength: 32 }).map(
  (value) => `caller-value-${value}`,
);
const fileExtension = string({ maxLength: 8 });
type FieldCase = {
  type: 'field';
  fieldname: string;
  value: string;
  truncated: false;
};
const field = tuple(fieldName, fieldValue).map(([fieldname, value]) => ({
  type: 'field' as const,
  fieldname,
  value,
  truncated: false as const,
}));
const invalidCases = array(field, { maxLength: 6 }).chain((fields) =>
  tuple(fileExtension, uint8Array({ minLength: 100, maxLength: 512 })).map(
    ([extension, bytes]) =>
      [
        fields,
        { filename: `audio.${extension}`, bytes: Array.from(bytes) },
      ] as const,
  ),
);
const validCases = tuple(
  integer({ min: 1, max: 3 }),
  string({ minLength: 1, maxLength: 32 }),
  constantFrom('wav', 'mp3', 'm4a', 'webm', 'ogg'),
  uint8Array({ minLength: 100, maxLength: 512 }),
  integer({ min: 0, max: 31 }),
  string({ maxLength: 32 }),
  constantFrom('Practice', 'Full-test'),
  string({ maxLength: 32 }),
  string({ maxLength: 32 }),
  string({ maxLength: 64 }),
).map(
  ([
    part,
    questionId,
    extension,
    bytes,
    optionalMask,
    promptText,
    testType,
    testCode,
    transcript,
    partResultId,
  ]) =>
    [
      [
        {
          type: 'field' as const,
          fieldname: 'part',
          value: String(part),
          truncated: false as const,
        },
        {
          type: 'field' as const,
          fieldname: 'question_id',
          value: questionId,
          truncated: false as const,
        },
        ...(optionalMask & 1
          ? [
              {
                type: 'field' as const,
                fieldname: 'prompt_text',
                value: promptText,
                truncated: false as const,
              },
            ]
          : []),
        ...(optionalMask & 2
          ? [
              {
                type: 'field' as const,
                fieldname: 'test_type',
                value: testType,
                truncated: false as const,
              },
            ]
          : []),
        ...(optionalMask & 4
          ? [
              {
                type: 'field' as const,
                fieldname: 'test_code',
                value: testCode,
                truncated: false as const,
              },
            ]
          : []),
        ...(optionalMask & 8
          ? [
              {
                type: 'field' as const,
                fieldname: 'transcript',
                value: transcript,
                truncated: false as const,
              },
            ]
          : []),
        ...(optionalMask & 16
          ? [
              {
                type: 'field' as const,
                fieldname: 'part_result_id',
                value: partResultId,
                truncated: false as const,
              },
            ]
          : []),
      ],
      { filename: `audio.${extension}`, bytes: Array.from(bytes) },
    ] as const,
);
const cases = oneof(invalidCases, validCases);

function multipartSource(
  items: SpeakingMultipartPart[],
): SpeakingMultipartSource {
  return {
    parts: () =>
      (async function* streamParts() {
        yield* items;
      })(),
    abort: () => undefined,
  };
}

function toParts(
  fields: readonly FieldCase[],
  file: { filename: string; bytes: number[] },
): SpeakingMultipartPart[] {
  return [
    ...fields,
    {
      type: 'file',
      fieldname: 'audio',
      filename: file.filename,
      contentType: 'audio/wav',
      bytes: (async function* stream() {
        yield Uint8Array.from(file.bytes);
      })(),
      truncated: () => false,
    },
  ];
}

describe('Speaking multipart fuzz (#626)', () => {
  let startedAt: number;

  beforeAll(() => {
    startedAt = performance.now();
  });

  it('returns schema-valid parsed requests or a documented AppError', async () => {
    const property = asyncProperty(cases, async ([fields, file]) => {
      let outcome:
        | { accepted: true; valid: boolean }
        | { accepted: false; allowedError: boolean; noReflection: boolean };
      const items = toParts(fields, file);
      try {
        const input = await new FastifySpeakingMultipartParser().parse(
          multipartSource(items),
          new AbortController().signal,
        );
        outcome = {
          accepted: true,
          valid: Value.Check(SpeakingGradeRequestSchema, {
            audio: 'uploaded',
            part: input.part,
            question_id: input.questionId,
            ...(input.promptText === undefined
              ? {}
              : { prompt_text: input.promptText }),
            test_type: input.testType,
            ...(input.testCode === undefined
              ? {}
              : { test_code: input.testCode }),
            ...(input.transcript === undefined
              ? {}
              : { transcript: input.transcript }),
          }),
        };
      } catch (error) {
        const isAppError = error instanceof AppError;
        const code = isAppError ? error.code : undefined;
        const message = isAppError
          ? (error.publicMessage ?? error.message)
          : '';
        const noReflection =
          code !== 'INVALID_REQUEST' ||
          fields.every(
            (part) =>
              (part.fieldname.length < 8 ||
                !message.includes(part.fieldname)) &&
              (part.value.length < 8 || !message.includes(part.value)),
          );
        outcome = {
          accepted: false,
          allowedError:
            isAppError &&
            code !== undefined &&
            [
              'INVALID_REQUEST',
              'PAYLOAD_TOO_LARGE',
              'AI_SERVICE_TIMEOUT',
            ].includes(code),
          noReflection,
        };
      }
      expect(
        outcome.accepted
          ? [true, outcome.valid]
          : [false, outcome.allowedError, outcome.noReflection],
      ).toEqual(outcome.accepted ? [true, true] : [false, true, true]);
    });
    await assertWithReproducer(
      property,
      seeds.speakingMultipart,
      'speaking-multipart.json',
    );
  });

  it('validates v2 question multipart inputs and sanitizes rejections', async () => {
    const property = asyncProperty(cases, async ([fields, file]) => {
      let outcome: [boolean, boolean, boolean, boolean];
      try {
        const input =
          await new FastifySpeakingMultipartParser().parseQuestionV2(
            multipartSource(toParts(fields, file)),
            new AbortController().signal,
          );
        outcome = [
          true,
          Value.Check(SpeakingV2QuestionGradeRequestSchema, {
            part: input.part,
            question_id: input.questionId,
            ...(input.promptText === undefined
              ? {}
              : { prompt_text: input.promptText }),
            ...(input.testType === undefined
              ? {}
              : { test_type: input.testType }),
            ...(input.testCode === undefined
              ? {}
              : { test_code: input.testCode }),
            ...(input.partResultId === undefined
              ? {}
              : { part_result_id: input.partResultId }),
          }),
          true,
          true,
        ];
      } catch (error) {
        const isAppError = error instanceof AppError;
        const code = isAppError ? error.code : undefined;
        const message = isAppError
          ? (error.publicMessage ?? error.message)
          : '';
        outcome = [
          false,
          isAppError &&
            code !== undefined &&
            [
              'INVALID_REQUEST',
              'PAYLOAD_TOO_LARGE',
              'AI_SERVICE_TIMEOUT',
            ].includes(code),
          code !== 'INVALID_REQUEST' ||
            fields.every(
              (part) =>
                (part.fieldname.length < 8 ||
                  !message.includes(part.fieldname)) &&
                (part.value.length < 8 || !message.includes(part.value)),
            ),
          true,
        ];
      }
      expect(outcome).toEqual(
        outcome[0] ? [true, true, true, true] : [false, true, true, true],
      );
    });
    await assertWithReproducer(
      property,
      seeds.speakingMultipart,
      'speaking-multipart-v2.json',
    );
  });

  it('keeps the multipart fuzz lane within its time budget', () => {
    expect(performance.now() - startedAt).toBeLessThan(
      seeds.speakingMultipartBudgetMs,
    );
  });
});
