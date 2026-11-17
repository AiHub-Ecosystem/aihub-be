import { AppError } from '@/common/errors/app-error';
import type {
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';

type SpeakingAudioUploadLookupPort = Pick<
  SpeakingAudioUploadRepositoryPort,
  'findUpload'
>;

/** One answer for every refusal, so a caller cannot tell a foreign asset from an absent one. */
export function speakingAudioAssetNotFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    message: 'Speaking audio asset not found',
    retryable: false,
  });
}

/**
 * Whether the owner may still grade this recording: an accepted asset bound to
 * the owner's Organization, End-User ID and environment (ADR-0070), inside its
 * retention deadline. An open or rejected upload, a foreign asset and an
 * expired one are all `false`.
 */
export async function hasLiveSpeakingAudioAsset(
  uploads: SpeakingAudioUploadLookupPort,
  owner: SpeakingAudioUploadOwner,
  now: Date,
): Promise<boolean> {
  const found = await uploads.findUpload(owner);
  return (
    found.kind === 'asset' &&
    found.asset.retentionExpiresAt.getTime() > now.getTime()
  );
}

/** Refuses a recording URL whose asset the caller may not grade, as an unknown asset. */
export class SpeakingRecordingAccess {
  constructor(
    private readonly uploads: SpeakingAudioUploadLookupPort,
    private readonly now: () => Date,
  ) {}

  async assertLive(owner: SpeakingAudioUploadOwner): Promise<void> {
    if (!(await hasLiveSpeakingAudioAsset(this.uploads, owner, this.now()))) {
      throw speakingAudioAssetNotFound();
    }
  }
}
