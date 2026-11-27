import { AppError } from '@/common/errors/app-error';
import { storageUnavailable } from '@/common/errors/upload-errors';
import type {
  SpeakingAudioAssetStoragePort,
  SpeakingAudioUploadOwner,
  SpeakingAudioUploadRepositoryPort,
} from '@/modules/speaking/application/audio/speaking-audio-upload.port';
import {
  type SpeakingAudioAsset,
  speakingAudioObjectKey,
} from '@/modules/speaking/domain/speaking-audio-asset';

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
 * expired one are all `false`. The clock is read after the lookup, so an asset
 * that expires while the lookup is in flight is refused.
 */
export async function hasLiveSpeakingAudioAsset(
  uploads: SpeakingAudioUploadLookupPort,
  owner: SpeakingAudioUploadOwner,
  now: () => Date,
): Promise<boolean> {
  const found = await uploads.findUpload(owner);
  return (
    found.kind === 'asset' &&
    found.asset.retentionExpiresAt.getTime() > now().getTime()
  );
}

/** Refuses a recording URL whose asset the caller may not grade, as an unknown asset. */
export class SpeakingRecordingAccess {
  constructor(
    private readonly uploads: SpeakingAudioUploadLookupPort,
    private readonly now: () => Date,
    private readonly storage?: SpeakingAudioAssetStoragePort,
  ) {}

  async assertLive(owner: SpeakingAudioUploadOwner): Promise<void> {
    await this.requireLiveAsset(owner);
  }

  private async requireLiveAsset(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioAsset> {
    const found = await this.uploads.findUpload(owner);
    if (
      found.kind !== 'asset' ||
      found.asset.retentionExpiresAt.getTime() <= this.now().getTime()
    ) {
      throw speakingAudioAssetNotFound();
    }
    return found.asset;
  }

  async gradingUrl(
    owner: SpeakingAudioUploadOwner,
    legacyUrl: string,
  ): Promise<string> {
    const asset = await this.requireLiveAsset(owner);
    const legacyObjectKey = speakingAudioObjectKey(
      owner.organizationId,
      owner.assetId,
    );
    if (asset.objectKey === legacyObjectKey) return legacyUrl;
    if (this.storage?.createReadUrl === undefined) {
      throw storageUnavailable(
        'SPEAKING_AUDIO_STORAGE_UNAVAILABLE',
        'Speaking audio storage is unavailable',
      );
    }
    return this.storage.createReadUrl({
      environment: asset.environment,
      objectKey: asset.objectKey,
    });
  }
}
