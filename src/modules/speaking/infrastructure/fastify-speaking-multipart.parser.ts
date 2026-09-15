import multipart from '@fastify/multipart';
import { Injectable } from '@nestjs/common';
import { Value } from '@sinclair/typebox/value';

import { AppError } from '../../../common/errors/app-error';
import {
  type SpeakingGradeInput,
  SpeakingGradeRequestSchema,
} from '../../../contracts/speaking/grading';
import type {
  SpeakingMultipartFilePart,
  SpeakingMultipartParserPort,
  SpeakingMultipartSource,
} from '../application/speaking-multipart-parser.port';

export const SPEAKING_AUDIO_MAX_BYTES = 25 * 1024 * 1024;

const MULTIPART_LIMITS = {
  fileSize: SPEAKING_AUDIO_MAX_BYTES,
  fieldSize: 64 * 1024,
  files: 1,
  fields: 7,
  parts: 8,
} as const;

const ALLOWED_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'webm', 'ogg']);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalidRequest(message = 'Request failed validation'): AppError {
  return new AppError({
    code: 'INVALID_REQUEST',
    message,
    retryable: false,
  });
}

function payloadTooLarge(): AppError {
  return new AppError({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body is too large',
    retryable: false,
  });
}

function uploadTimedOut(): AppError {
  return new AppError({
    code: 'AI_SERVICE_TIMEOUT',
    message: 'AI service request timed out',
    retryable: true,
  });
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

function isFileTooLarge(error: unknown): boolean {
  return isRecord(error) && error.code === 'FST_REQ_FILE_TOO_LARGE';
}

async function readAudio(
  part: SpeakingMultipartFilePart,
  signal: AbortSignal,
): Promise<Buffer> {
  if (signal.aborted) {
    throw uploadTimedOut();
  }

  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of part.bytes) {
      if (signal.aborted) {
        throw uploadTimedOut();
      }

      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > SPEAKING_AUDIO_MAX_BYTES) {
        throw payloadTooLarge();
      }
      chunks.push(Buffer.from(bytes));
    }

    if (part.truncated()) {
      throw payloadTooLarge();
    }

    return Buffer.concat(chunks);
  } catch (error) {
    if (signal.aborted) {
      throw uploadTimedOut();
    }
    throw error;
  }
}

function parseFields(
  fields: ReadonlyMap<string, string>,
): Omit<SpeakingGradeInput, 'audio'> {
  for (const field of fields.keys()) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw invalidRequest(`Unknown field ${field}`);
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
    throw invalidRequest();
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

@Injectable()
export class FastifySpeakingMultipartParser
  implements SpeakingMultipartParserPort
{
  async parse(
    source: SpeakingMultipartSource,
    signal: AbortSignal,
  ): Promise<SpeakingGradeInput> {
    const fields = new Map<string, string>();
    let audio: SpeakingGradeInput['audio'] | undefined;
    const abort = (): void => source.abort();
    signal.addEventListener('abort', abort, { once: true });

    try {
      for await (const part of source.parts(MULTIPART_LIMITS)) {
        if (part.type === 'file') {
          if (audio !== undefined || part.fieldname !== 'audio') {
            throw invalidRequest('Exactly one audio field is required');
          }
          if (!ALLOWED_EXTENSIONS.has(extensionOf(part.filename))) {
            throw invalidRequest('Audio format is not supported');
          }

          const bytes = await readAudio(part, signal);
          audio = {
            bytes,
            filename: part.filename,
            contentType: part.contentType,
          };
          continue;
        }

        if (fields.has(part.fieldname)) {
          throw invalidRequest(`Duplicate field ${part.fieldname}`);
        }
        if (part.truncated) {
          throw payloadTooLarge();
        }
        if (typeof part.value !== 'string') {
          throw invalidRequest(`Field ${part.fieldname} must be text`);
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
        throw uploadTimedOut();
      }
      throw invalidRequest();
    } finally {
      signal.removeEventListener('abort', abort);
    }

    if (audio === undefined || audio.bytes.length < 100) {
      throw invalidRequest('Audio must be at least 100 bytes');
    }

    return { audio, ...parseFields(fields) };
  }
}

export function registerSpeakingMultipartParser(
  instance: MultipartRegistrableInstance,
): void {
  // Fastify's global bodyLimit is intentionally small for JSON routes. The
  // multipart route gets its catalog limit at route registration time so the
  // parser can stream up to the audio ceiling without widening JSON routes.
  Reflect.apply(instance.addHook, instance, [
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
        route.bodyLimit = SPEAKING_AUDIO_MAX_BYTES;
      }
    },
  ]);
  Reflect.apply(instance.register, instance, [
    multipart,
    {
      limits: MULTIPART_LIMITS,
      throwFileSizeLimit: true,
    },
  ]);
}
