import type { RequestContext } from '@/common/request-context/request-context';
import type {
  PublishedUploadSession,
  UploadSessionCleanupCandidate,
  UploadSessionIntent,
  UploadSessionLookup,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

export interface UploadSessionGrant {
  readonly assetId: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly uploadUrl: string;
  readonly uploadFields: Readonly<Record<string, string>>;
  readonly uploadUrlExpiresAt: Date;
  readonly intentExpiresAt: Date;
}

export interface UploadSessionRepositoryPort {
  createIntent(
    intent: UploadSessionIntent,
    rateWindowMs?: number,
  ): Promise<boolean>;
  findUpload(owner: UploadSessionOwner): Promise<UploadSessionLookup>;
  rejectIntent(owner: UploadSessionOwner, now: Date): Promise<void>;
  beginPublication(input: {
    readonly owner: UploadSessionOwner;
    readonly now: Date;
    readonly rateWindowMs?: number;
  }): Promise<'started' | 'published' | 'limited' | 'in_progress' | 'missing'>;
  markPublished(input: {
    readonly owner: UploadSessionOwner;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
  }): Promise<PublishedUploadSession | 'revoked' | undefined>;
  releasePublication(
    owner: UploadSessionOwner,
    publicationStartedAt: Date,
  ): Promise<void>;
  cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly UploadSessionCleanupCandidate[]>;
  removeCleanupCandidate(
    candidate: UploadSessionCleanupCandidate,
  ): Promise<boolean>;
}

export interface UploadSessionStoragePort {
  createUploadUrl(input: {
    readonly environment: string;
    readonly stagingKey: string;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }>;
  inspectObject(
    input: {
      readonly environment: string;
      readonly stagingKey: string;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: string | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
      }
    | undefined
  >;
  publishObject(
    input: {
      readonly environment: string;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: string;
      readonly bytes: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  publicUrl(input: {
    readonly environment: string;
    readonly publishedKey: string;
  }): string;
  deleteStagingObject(
    input: { readonly environment: string; readonly stagingKey: string },
    signal?: AbortSignal,
  ): Promise<void>;
  deletePublishedObject(
    input: { readonly environment: string; readonly publishedKey: string },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface UploadSessionServicePort {
  create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<UploadSessionGrant>;
  refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<UploadSessionGrant>;
  complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<PublishedUploadSession>;
}
