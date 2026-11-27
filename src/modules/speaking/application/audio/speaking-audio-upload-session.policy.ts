import { AppError } from '@/common/errors/app-error';
import { invalidRequest } from '@/common/errors/invalid-request';
import {
  payloadTooLarge,
  storageUnavailable,
  uploadNotFound,
} from '@/common/errors/upload-errors';
import {
  SPEAKING_AUDIO_MAX_BYTES,
  SPEAKING_AUDIO_MIN_BYTES,
  SPEAKING_AUDIO_ORPHAN_GRACE_MS,
  SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS,
  type SpeakingAudioContentType,
  type SpeakingAudioEnvironment,
  isSpeakingAudioAssetId,
  isSpeakingAudioContentType,
  speakingAudioObjectKey,
  speakingAudioStagingObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';
import type { UploadSessionPolicy } from '@/modules/uploads/public';
import { SPEAKING_AUDIO_COMPLETION_DEADLINE_MS } from './speaking-audio-completion-timeouts';
import { SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS } from './speaking-audio-org-ceiling.policy';

function rateLimited(): AppError {
  return new AppError({
    code: 'RATE_LIMITED',
    message: 'Speaking audio upload limit reached; retry later',
    retryable: true,
    retryAfterMs: SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS,
  });
}

function storageUnavailableForFeature(): AppError {
  return storageUnavailable(
    'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
    'Speaking audio storage is unavailable',
  );
}

function notFound(): AppError {
  return uploadNotFound('NOT_FOUND', 'Speaking audio upload was not found');
}

function isSpeakingEnvironment(
  value: string | undefined,
): value is SpeakingAudioEnvironment {
  return value === 'production' || value === 'sandbox';
}

function organizationOf(owner: {
  readonly organizationId?: string;
}): string {
  if (owner.organizationId === undefined) throw storageUnavailableForFeature();
  return owner.organizationId;
}

/** Speaking's storage is HEAD-only, so it supplies no byte-verification port. */
export function speakingAudioUploadSessionPolicy(): UploadSessionPolicy<
  SpeakingAudioContentType,
  SpeakingAudioEnvironment
> {
  return {
    maxBytes: SPEAKING_AUDIO_MAX_BYTES,
    minBytes: SPEAKING_AUDIO_MIN_BYTES,
    intentTtlMs: SPEAKING_AUDIO_UPLOAD_INTENT_TTL_MS,
    rateWindowMs: SPEAKING_AUDIO_ORG_ISSUANCE_WINDOW_MS,
    orphanGraceMs: SPEAKING_AUDIO_ORPHAN_GRACE_MS,
    owner: (context, assetId) => {
      const { organizationId, userId, environment } = context;
      if (
        organizationId === undefined ||
        userId === undefined ||
        !isSpeakingEnvironment(environment)
      ) {
        throw storageUnavailableForFeature();
      }
      return {
        assetId,
        organizationId,
        endUserId: userId,
        environment,
      };
    },
    waitForPublication: true,
    completionSignal: (signal) =>
      AbortSignal.any([
        signal,
        AbortSignal.timeout(SPEAKING_AUDIO_COMPLETION_DEADLINE_MS),
      ]),
    isContentType: (value) => isSpeakingAudioContentType(value),
    isAssetId: (value) => isSpeakingAudioAssetId(value),
    stagingKey: (owner) =>
      speakingAudioStagingObjectKey(organizationOf(owner), owner.assetId),
    publishedKey: (owner) =>
      speakingAudioObjectKey(organizationOf(owner), owner.assetId),
    invalidRequest: () => invalidRequest(),
    payloadTooLarge: () =>
      payloadTooLarge(
        'PAYLOAD_TOO_LARGE',
        'Speaking audio recording is larger than 25 MiB',
      ),
    rateLimited: () => rateLimited(),
    storageUnavailable: () => storageUnavailableForFeature(),
    notFound: () => notFound(),
  };
}
