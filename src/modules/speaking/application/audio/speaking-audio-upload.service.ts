import type { RequestContext } from '@/common/request-context/request-context';
import {
  type SpeakingAudioAsset,
  type SpeakingAudioContentType,
  type SpeakingAudioEnvironment,
} from '@/modules/speaking/domain/speaking-audio-asset';
import type { UploadSessionServicePort } from '@/modules/uploads/public';
import { speakingAudioUploadSessionPolicy } from './speaking-audio-upload-session.policy';
import type {
  SpeakingAudioUploadGrant,
  SpeakingAudioUploadServicePort,
} from './speaking-audio-upload.port';

/** Maps Speaking's vocabulary onto the shared core; no lifecycle logic here. */
export class SpeakingAudioUploadService
  implements SpeakingAudioUploadServicePort
{
  private readonly policy = speakingAudioUploadSessionPolicy();

  constructor(
    private readonly core: UploadSessionServicePort<
      SpeakingAudioContentType,
      SpeakingAudioEnvironment
    >,
  ) {}

  async requestUpload(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<SpeakingAudioUploadGrant> {
    const grant = await this.core.create(input);
    const owner = this.policy.owner(input.context, grant.assetId);
    return {
      assetId: grant.assetId,
      objectKey: this.policy.publishedKey(owner),
      contentType: grant.contentType,
      byteSize: grant.byteSize,
      uploadUrl: grant.uploadUrl,
      uploadUrlExpiresAt: grant.uploadUrlExpiresAt,
      intentExpiresAt: grant.intentExpiresAt,
    };
  }

  async refreshUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<SpeakingAudioUploadGrant> {
    const grant = await this.core.refresh(input);
    const owner = this.policy.owner(input.context, grant.assetId);
    return {
      assetId: grant.assetId,
      objectKey: this.policy.publishedKey(owner),
      contentType: grant.contentType,
      byteSize: grant.byteSize,
      uploadUrl: grant.uploadUrl,
      uploadUrlExpiresAt: grant.uploadUrlExpiresAt,
      intentExpiresAt: grant.intentExpiresAt,
    };
  }

  async completeUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<{
    readonly asset: SpeakingAudioAsset;
    readonly created: boolean;
  }> {
    const published = await this.core.complete(input);
    return {
      asset: {
        assetId: published.assetId,
        organizationId: published.organizationId ?? '',
        endUserId: published.endUserId,
        environment: published.environment,
        objectKey: published.publishedKey,
        contentType: published.contentType,
        byteSize: published.byteSize,
        acceptedAt: published.publishedAt,
        retentionExpiresAt:
          published.retentionExpiresAt ?? published.publishedAt,
      },
      created: published.created ?? false,
    };
  }
}
