import type { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import { payloadTooLarge } from '@/common/errors/upload-errors';
import {
  SPEAKING_AUDIO_MAX_BYTES,
  SPEAKING_AUDIO_MIN_BYTES,
  isSpeakingAudioContentType,
} from '@/modules/speaking/domain/speaking-audio-asset';

type DescribedObject = {
  readonly contentType: string | undefined;
  readonly byteSize: number | undefined;
};

type ExpectedUpload = {
  readonly contentType: string;
  readonly byteSize: number;
};

function tooLarge(): AppError {
  return payloadTooLarge(
    'PAYLOAD_TOO_LARGE',
    'Speaking audio recording is larger than 25 MiB',
  );
}

export function speakingStagingRefusal(
  stored: DescribedObject,
  expected: ExpectedUpload,
): AppError | undefined {
  if (
    stored.byteSize !== undefined &&
    Number.isInteger(stored.byteSize) &&
    stored.byteSize > SPEAKING_AUDIO_MAX_BYTES
  ) {
    return tooLarge();
  }
  if (
    !isSpeakingAudioContentType(stored.contentType) ||
    stored.byteSize === undefined ||
    !Number.isInteger(stored.byteSize) ||
    stored.byteSize < SPEAKING_AUDIO_MIN_BYTES ||
    stored.contentType !== expected.contentType ||
    stored.byteSize !== expected.byteSize
  ) {
    return invalidRequest();
  }
  return undefined;
}

export function speakingFinalRefusal(
  final: DescribedObject,
  expected: ExpectedUpload,
): AppError | undefined {
  return speakingStagingRefusal(final, expected);
}
