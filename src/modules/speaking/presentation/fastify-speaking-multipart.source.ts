import { AppError } from '@/common/errors/app-error';
import type {
  SpeakingMultipartLimits,
  SpeakingMultipartPart,
  SpeakingMultipartSource,
} from '@/modules/speaking/application/speaking-multipart-parser.port';

interface FastifyFileStream {
  readonly truncated?: boolean;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array | string>;
  destroy(error?: Error): void;
}

interface FastifyFilePart {
  readonly type: 'file';
  readonly fieldname: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly file: FastifyFileStream;
}

interface FastifyFieldPart {
  readonly type: 'field';
  readonly fieldname: string;
  readonly value: unknown;
  readonly valueTruncated?: boolean;
}

type FastifyMultipartPart = FastifyFilePart | FastifyFieldPart;

interface FastifyMultipartRequest {
  parts(options?: unknown): AsyncIterableIterator<FastifyMultipartPart>;
  readonly raw?: {
    destroy(error?: Error): void;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFastifyMultipartRequest(
  value: unknown,
): value is FastifyMultipartRequest {
  return isRecord(value) && typeof value.parts === 'function';
}

async function* mapFileBytes(
  stream: FastifyFileStream,
): AsyncIterableIterator<Uint8Array> {
  for await (const chunk of stream) {
    yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
  }
}

function mapPart(part: FastifyMultipartPart): SpeakingMultipartPart {
  if (part.type === 'file') {
    return {
      type: 'file',
      fieldname: part.fieldname,
      filename: part.filename,
      contentType: part.mimetype,
      bytes: mapFileBytes(part.file),
      truncated: () => part.file.truncated === true,
    };
  }

  return {
    type: 'field',
    fieldname: part.fieldname,
    value: part.value,
    truncated: part.valueTruncated === true,
  };
}

async function* mapParts(
  request: FastifyMultipartRequest,
  options: SpeakingMultipartLimits,
): AsyncIterableIterator<SpeakingMultipartPart> {
  for await (const part of request.parts({ limits: options })) {
    yield mapPart(part);
  }
}

export function createFastifySpeakingMultipartSource(
  request: unknown,
): SpeakingMultipartSource {
  if (!isFastifyMultipartRequest(request)) {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      message: 'Multipart handling is not configured',
      retryable: false,
    });
  }

  return {
    parts: (options) => mapParts(request, options),
    abort: () => request.raw?.destroy(),
  };
}
