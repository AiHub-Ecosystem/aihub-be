import type { RequestContext } from '@/common/request-context/request-context';
import type {
  SpeakingAudioAsset,
  SpeakingAudioContentType,
  SpeakingAudioEnvironment,
  SpeakingAudioUploadIntent,
} from '@/modules/speaking/domain/speaking-audio-asset';

export type SpeakingAudioUploadLookup =
  | { readonly kind: 'intent'; readonly intent: SpeakingAudioUploadIntent }
  | { readonly kind: 'asset'; readonly asset: SpeakingAudioAsset }
  | { readonly kind: 'missing' };

export interface SpeakingAudioUploadOwner {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: SpeakingAudioEnvironment;
}

export interface SpeakingAudioUploadRepositoryPort {
  createIntent(intent: SpeakingAudioUploadIntent): Promise<void>;
  findUpload(
    owner: SpeakingAudioUploadOwner,
  ): Promise<SpeakingAudioUploadLookup>;
  confirmRefreshableIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean>;
  rejectIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
  }): Promise<boolean>;
  removeRejectedIntent(owner: SpeakingAudioUploadOwner): Promise<void>;
  completeIntent(input: {
    readonly owner: SpeakingAudioUploadOwner;
    readonly now: Date;
    readonly asset: SpeakingAudioAsset;
  }): Promise<'created' | 'already_completed' | 'missing'>;
  listCleanupCandidates(input: {
    readonly expiredBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly SpeakingAudioUploadIntent[]>;
  removeCleanupCandidate(input: {
    readonly intent: SpeakingAudioUploadIntent;
    readonly expiredBefore: Date;
  }): Promise<boolean>;
}

export interface SpeakingAudioAssetStoragePort {
  createUploadUrl(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
    readonly contentType: SpeakingAudioContentType;
    readonly byteSize: number;
  }): Promise<{ readonly url: string; readonly expiresAt: Date }>;
  describeObject(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
  }): Promise<
    | {
        readonly contentType: string | undefined;
        readonly byteSize: number | undefined;
      }
    | undefined
  >;
  deleteObject(input: {
    readonly environment: SpeakingAudioEnvironment;
    readonly objectKey: string;
  }): Promise<void>;
}

/**
 * What a caller is granted for one upload: the object to send bytes to, and
 * the two separate deadlines that bound it. `uploadUrlExpiresAt` is the
 * signature's life and is the one a refresh replaces; `intentExpiresAt` is
 * the intent's own life and no refresh extends it.
 */
export interface SpeakingAudioUploadGrant {
  readonly assetId: string;
  readonly objectKey: string;
  readonly contentType: SpeakingAudioContentType;
  readonly byteSize: number;
  readonly uploadUrl: string;
  readonly uploadUrlExpiresAt: Date;
  readonly intentExpiresAt: Date;
}

export interface SpeakingAudioUploadServicePort {
  requestUpload(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<SpeakingAudioUploadGrant>;
  refreshUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<SpeakingAudioUploadGrant>;
  completeUpload(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<{
    readonly asset: SpeakingAudioAsset;
    readonly created: boolean;
  }>;
}

export const SPEAKING_AUDIO_UPLOAD_REPOSITORY = Symbol(
  'SPEAKING_AUDIO_UPLOAD_REPOSITORY',
);
export const SPEAKING_AUDIO_ASSET_STORAGE = Symbol(
  'SPEAKING_AUDIO_ASSET_STORAGE',
);
export const SPEAKING_AUDIO_UPLOAD_SERVICE = Symbol(
  'SPEAKING_AUDIO_UPLOAD_SERVICE',
);
export const SPEAKING_AUDIO_UPLOAD_CLOCK = Symbol(
  'SPEAKING_AUDIO_UPLOAD_CLOCK',
);
