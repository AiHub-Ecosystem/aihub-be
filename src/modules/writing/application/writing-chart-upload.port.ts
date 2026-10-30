import type { RequestContext } from '@/common/request-context/request-context';
import type {
  WritingChartAsset,
  WritingChartContentType,
  WritingChartEnvironment,
  WritingChartUploadIntent,
} from '@/modules/writing/domain/writing-chart-upload';

export interface WritingChartUploadOwner {
  readonly assetId: string;
  readonly organizationId: string;
  readonly endUserId: string;
  readonly environment: WritingChartEnvironment;
}

export type WritingChartUploadLookup =
  | { readonly kind: 'intent'; readonly intent: WritingChartUploadIntent }
  | { readonly kind: 'asset'; readonly asset: WritingChartAsset }
  | { readonly kind: 'missing' };

export interface WritingChartCleanupCandidate {
  readonly kind: 'intent' | 'asset';
  readonly assetId: string;
  readonly environment: WritingChartEnvironment;
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly createdAt: Date;
}

export interface WritingChartUploadRepositoryPort {
  createIntent(intent: WritingChartUploadIntent): Promise<boolean>;
  findUpload(owner: WritingChartUploadOwner): Promise<WritingChartUploadLookup>;
  rejectIntent(owner: WritingChartUploadOwner, now: Date): Promise<void>;
  beginPublication(input: {
    readonly owner: WritingChartUploadOwner;
    readonly now: Date;
  }): Promise<'started' | 'published' | 'limited' | 'in_progress' | 'missing'>;
  /**
   * `revoked` when an operator revoked the asset after its reservation: the
   * row is rejected and the caller removes the object it wrote (#1206).
   */
  markPublished(input: {
    readonly owner: WritingChartUploadOwner;
    readonly now: Date;
    /** The timestamp used by the successful begin attempt. */
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
  }): Promise<WritingChartAsset | 'revoked' | undefined>;
  releasePublication(
    owner: WritingChartUploadOwner,
    publicationStartedAt: Date,
  ): Promise<void>;
  cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly WritingChartCleanupCandidate[]>;
  removeCleanupCandidate(
    candidate: WritingChartCleanupCandidate,
  ): Promise<boolean>;
}

export interface WritingChartUploadStoragePort {
  createUploadUrl(input: {
    readonly environment: WritingChartEnvironment;
    readonly stagingKey: string;
    readonly contentType: WritingChartContentType;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }>;
  inspectObject(
    input: {
      readonly environment: WritingChartEnvironment;
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
      readonly environment: WritingChartEnvironment;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: WritingChartContentType;
      readonly bytes: Uint8Array;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  publicUrl(input: {
    readonly environment: WritingChartEnvironment;
    readonly publishedKey: string;
  }): string;
  deleteStagingObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly stagingKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  deletePublishedObject(
    input: {
      readonly environment: WritingChartEnvironment;
      readonly publishedKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WritingChartUploadGrant {
  readonly assetId: string;
  readonly contentType: WritingChartContentType;
  readonly byteSize: number;
  readonly uploadUrl: string;
  readonly uploadFields: Readonly<Record<string, string>>;
  readonly uploadUrlExpiresAt: Date;
  readonly intentExpiresAt: Date;
}

export interface WritingChartUploadServicePort {
  create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<WritingChartUploadGrant>;
  refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<WritingChartUploadGrant>;
  complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<WritingChartAsset>;
}

export const WRITING_CHART_UPLOAD_REPOSITORY = Symbol(
  'WRITING_CHART_UPLOAD_REPOSITORY',
);
export const WRITING_CHART_UPLOAD_STORAGE = Symbol(
  'WRITING_CHART_UPLOAD_STORAGE',
);
export const WRITING_CHART_UPLOAD_SERVICE = Symbol(
  'WRITING_CHART_UPLOAD_SERVICE',
);
export const WRITING_CHART_UPLOAD_CLOCK = Symbol('WRITING_CHART_UPLOAD_CLOCK');
