import { Blob } from 'node:buffer';
import { isRecord } from '@/common/is-record';

import multipart from '@fastify/multipart';
import { Injectable } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { AppError, timeoutError } from '@/common/errors/app-error';
import { containsUnstorableText } from '@/common/http/parsing/unstorable-text';
import {
  type SpeakingAudio,
  type SpeakingGradeInput,
  SpeakingGradeRequestSchema,
} from '@/contracts/speaking/grading';
import type { SpeakingV2QuestionGradeInput } from '@/contracts/speaking/v2/inputs';
import { SpeakingV2QuestionGradeRequestSchema } from '@/contracts/speaking/v2/requests';
import { isSpeakingV2TestType } from '@/contracts/speaking/v2/test-type';
import type {
  SpeakingMultipartFilePart,
  SpeakingMultipartParserPort,
  SpeakingMultipartSource,
} from '@/modules/speaking/application/audio/speaking-multipart-parser.port';
import { SPEAKING_AUDIO_MAX_BYTES } from '@/modules/speaking/domain/speaking-audio-asset';

const MULTIPART_LIMITS = {
  fileSize: SPEAKING_AUDIO_MAX_BYTES,
  fieldSize: 64 * 1024,
  files: 1,
  fields: 7,
  parts: 8,
} as const;

export const ALLOWED_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'webm', 'ogg']);
const ALLOWED_FIELDS = new Set([
  'part',
  'question_id',
  'prompt_text',
  'test_type',
  'test_code',
  'transcript',
]);

interface MultipartRegistrableInstance {
  register(...args: never[]): unknown;
  addHook(...args: never[]): unknown;
}

type Reject = (
  diagnostic: string,
  details?: Readonly<Record<string, unknown>>,
  message?: string,
) => AppError;

/**
 * Fixed tokens naming the multipart branch that refused a request. They reach
 * the operator log, so one must never carry a field name, value, or file name
 * a caller supplied (#2014, #1213).
 */
const FRAMEWORK_TOKENS = new Map<string, string>([
  ['FST_INVALID_MULTIPART_CONTENT_TYPE', 'multipart:not-multipart'],
  ['FST_INVALID_JSON_FIELD_ERROR', 'multipart:field-json'],
  ['FST_MP_PREMATURE_CLOSE', 'multipart:incomplete-body'],
  ['FST_PROTO_VIOLATION', 'multipart:prototype-field'],
  ['FST_FIELDS_LIMIT', 'multipart:fields-limit'],
  ['FST_PARTS_LIMIT', 'multipart:parts-limit'],
  ['FST_FILES_LIMIT', 'multipart:files-limit'],
]);

function frameworkToken(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const code = error['code'];
  return typeof code === 'string' ? FRAMEWORK_TOKENS.get(code) : undefined;
}

/** The diagnostic is for the log; `details` names the refused field back to an
 * authenticated caller only, the split `parseRequestBody` already makes. */
function rejectionFor(authenticated: boolean): Reject {
  return (diagnostic, details, message = 'Request failed validation') =>
    new AppError({
      code: 'INVALID_REQUEST',
      message,
      retryable: false,
      ...(authenticated && details !== undefined ? { details } : {}),
      diagnostic,
    });
}

function schemaDetails(
  errors: readonly { readonly path: string; readonly message: string }[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    errors.map((error) => [
      error.path === '' ? '/' : error.path,
      error.message,
    ]),
  );
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body is too large',
    retryable: false,
  });
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isFileTooLarge(error: unknown): boolean {
  return isRecord(error) && error['code'] === 'FST_REQ_FILE_TOO_LARGE';
}

// The chunks are the stream's own buffers, kept by reference; building the
// Blob is the one copy of the audio the request holds until dispatch (#270).
async function readAudio(
  part: SpeakingMultipartFilePart,
  signal: AbortSignal,
): Promise<Blob> {
  if (signal.aborted) {
    throw timeoutError();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for await (const chunk of part.bytes) {
      if (signal.aborted) {
        throw timeoutError();
      }

      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > SPEAKING_AUDIO_MAX_BYTES) {
        throw payloadTooLarge();
      }
      chunks.push(bytes);
    }

    if (part.truncated()) {
      throw payloadTooLarge();
    }

    return new Blob(chunks);
  } catch (error) {
    if (signal.aborted) {
      throw timeoutError();
    }
    throw error;
  }
}

function parseFields(
  fields: ReadonlyMap<string, string>,
  reject: Reject,
): Omit<SpeakingGradeInput, 'audio'> {
  for (const [field, value] of fields) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw reject('multipart:unknown-field', {
        [`/${field}`]: 'Unexpected property',
      });
    }
    if (containsUnstorableText(value)) {
      throw reject('multipart:unstorable-field', {
        [`/${field}`]: 'Unstorable character',
      });
    }
  }

  const part = Number(fields.get('part'));
  const questionId = fields.get('question_id');
  const promptText = fields.get('prompt_text');
  const testType = fields.get('test_type') ?? 'Practice';
  const testCode = fields.get('test_code');
  const transcript = fields.get('transcript');
  const boundaryValue = {
    audio: 'uploaded',
    part,
    question_id: questionId ?? '',
    ...(promptText === undefined ? {} : { prompt_text: promptText }),
    test_type: testType,
    ...(testCode === undefined ? {} : { test_code: testCode }),
    ...(transcript === undefined ? {} : { transcript }),
  };

  if (!Value.Check(SpeakingGradeRequestSchema, boundaryValue)) {
    throw reject(
      'multipart:schema',
      schemaDetails([
        ...Value.Errors(SpeakingGradeRequestSchema, boundaryValue),
      ]),
    );
  }

  return {
    part,
    questionId: questionId ?? '',
    ...(promptText === undefined ? {} : { promptText }),
    testType,
    ...(testCode === undefined ? {} : { testCode }),
    ...(transcript === undefined ? {} : { transcript }),
  };
}

const QUESTION_FIELDS_V2 = new Set([
  'part',
  'question_id',
  'prompt_text',
  'test_type',
  'test_code',
  'part_result_id',
]);

function parseQuestionFieldsV2(
  fields: ReadonlyMap<string, string>,
  reject: Reject,
): Omit<SpeakingV2QuestionGradeInput, 'audio'> {
  for (const [field, value] of fields) {
    if (!QUESTION_FIELDS_V2.has(field)) {
      throw reject('multipart:unknown-field', {
        [`/${field}`]: 'Unexpected property',
      });
    }
    if (containsUnstorableText(value)) {
      throw reject('multipart:unstorable-field', {
        [`/${field}`]: 'Unstorable character',
      });
    }
  }

  const part = Number(fields.get('part'));
  const questionId = fields.get('question_id') ?? '';
  const promptText = fields.get('prompt_text');
  const testType = fields.get('test_type');
  const testCode = fields.get('test_code');
  const partResultId = fields.get('part_result_id');
  const boundaryValue = {
    part,
    question_id: questionId,
    ...(promptText === undefined ? {} : { prompt_text: promptText }),
    ...(testType === undefined ? {} : { test_type: testType }),
    ...(testCode === undefined ? {} : { test_code: testCode }),
    ...(partResultId === undefined ? {} : { part_result_id: partResultId }),
  };

  if (!Value.Check(SpeakingV2QuestionGradeRequestSchema, boundaryValue)) {
    throw reject(
      'multipart:schema',
      schemaDetails([
        ...Value.Errors(SpeakingV2QuestionGradeRequestSchema, boundaryValue),
      ]),
    );
  }

  return {
    part,
    questionId,
    ...(promptText === undefined ? {} : { promptText }),
    ...(testType !== undefined && isSpeakingV2TestType(testType)
      ? { testType }
      : {}),
    ...(testCode === undefined ? {} : { testCode }),
    ...(partResultId === undefined ? {} : { partResultId }),
  };
}

@Injectable()
export class FastifySpeakingMultipartParser
  implements SpeakingMultipartParserPort
{
  parse(
    source: SpeakingMultipartSource,
    signal: AbortSignal,
    authenticated = false,
  ): Promise<SpeakingGradeInput> {
    return this.readMultipart(source, signal, authenticated, parseFields);
  }

  parseQuestionV2(
    source: SpeakingMultipartSource,
    signal: AbortSignal,
    authenticated = false,
  ): Promise<SpeakingV2QuestionGradeInput> {
    return this.readMultipart(
      source,
      signal,
      authenticated,
      parseQuestionFieldsV2,
    );
  }

  private async readMultipart<TFields>(
    source: SpeakingMultipartSource,
    signal: AbortSignal,
    authenticated: boolean,
    parseFieldValues: (
      fields: ReadonlyMap<string, string>,
      reject: Reject,
    ) => TFields,
  ): Promise<TFields & { readonly audio: SpeakingAudio }> {
    const reject = rejectionFor(authenticated);
    const fields = new Map<string, string>();
    let audio: SpeakingAudio | undefined;
    const abort = (): void => source.abort();
    signal.addEventListener('abort', abort, { once: true });

    try {
      for await (const part of source.parts(MULTIPART_LIMITS)) {
        if (part.type === 'file') {
          if (audio !== undefined || part.fieldname !== 'audio') {
            throw reject(
              'multipart:audio-field',
              { '/audio': 'Exactly one audio field is required' },
              'Exactly one audio field is required',
            );
          }
          if (!ALLOWED_EXTENSIONS.has(extensionOf(part.filename))) {
            throw reject(
              'multipart:audio-format',
              { '/audio': 'Audio format is not supported' },
              'Audio format is not supported',
            );
          }

          const blob = await readAudio(part, signal);
          audio = {
            blob,
            filename: part.filename,
            contentType: part.contentType,
          };
          continue;
        }

        if (fields.has(part.fieldname)) {
          throw reject('multipart:duplicate-field', {
            [`/${part.fieldname}`]: 'Field sent more than once',
          });
        }
        if (part.truncated) {
          throw payloadTooLarge();
        }
        if (typeof part.value !== 'string') {
          throw reject('multipart:non-text-field', {
            [`/${part.fieldname}`]: 'Expected text',
          });
        }
        fields.set(part.fieldname, part.value);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (isFileTooLarge(error)) {
        throw payloadTooLarge();
      }
      if (signal.aborted) {
        throw timeoutError();
      }
      const token = frameworkToken(error);
      throw reject(token ?? 'multipart:unreadable-body');
    } finally {
      signal.removeEventListener('abort', abort);
    }

    if (audio === undefined) {
      throw reject(
        'multipart:audio-missing',
        { '/audio': 'An audio file is required' },
        'Audio must be at least 100 bytes',
      );
    }
    if (audio.blob.size < 100) {
      throw reject(
        'multipart:audio-too-small',
        { '/audio': 'Audio must be at least 100 bytes' },
        'Audio must be at least 100 bytes',
      );
    }

    return { audio, ...parseFieldValues(fields, reject) };
  }
}

export function registerSpeakingMultipartParser(
  instance: MultipartRegistrableInstance,
): void {
  // Fastify's global bodyLimit is intentionally small for JSON routes. The
  // multipart route gets its catalog wire limit at route registration time so
  // the parser can stream a full-size audio file plus its multipart framing
  // without widening JSON routes. Per-file enforcement stays at the 25 MiB
  // provider cap above.
  Reflect.apply(instance.addHook.bind(instance), instance, [
    'onRoute',
    (route: {
      url?: string;
      method?: string | readonly string[];
      bodyLimit?: number;
    }): void => {
      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      if (
        route.url === '/v1/ielts/speaking/grading' &&
        methods.includes('POST')
      ) {
        route.bodyLimit = OPERATION_CATALOG['speaking.grading'].maxBodyBytes;
      }
      if (
        route.url === OPERATION_CATALOG['speaking.v2.question-grading'].path &&
        methods.includes('POST')
      ) {
        route.bodyLimit =
          OPERATION_CATALOG['speaking.v2.question-grading'].maxBodyBytes;
      }
    },
  ]);
  Reflect.apply(instance.register.bind(instance), instance, [
    multipart,
    {
      limits: MULTIPART_LIMITS,
      throwFileSizeLimit: true,
    },
  ]);
}
