import type { RequestContext } from '@/common/request-context/request-context';
import type {
  PublishedUploadSession,
  UploadSessionCleanupCandidate,
  UploadSessionEnvironment,
  UploadSessionIntent,
  UploadSessionLookup,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

export interface UploadSessionGrant<C extends string = string> {
  readonly assetId: string;
  readonly contentType: C;
  readonly byteSize: number;
  readonly uploadUrl: string;
  readonly uploadFields: Readonly<Record<string, string>>;
  readonly uploadUrlExpiresAt: Date;
  readonly intentExpiresAt: Date;
}

export interface UploadSessionPublicationReservation {
  readonly kind: 'started';
  readonly reservationId: string;
  readonly publishedKey: string;
}

export interface UploadSessionRepositoryPort<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
  P extends PublishedUploadSession<C, E> = PublishedUploadSession<C, E>,
> {
  createIntent(
    intent: UploadSessionIntent<C, E>,
    rateWindowMs?: number,
  ): Promise<boolean>;
  findUpload(
    owner: UploadSessionOwner<E>,
  ): Promise<UploadSessionLookup<C, E, P>>;
  rejectIntent(
    owner: UploadSessionOwner<E>,
    now: Date,
    cleaned?: boolean,
  ): Promise<void>;
  claimRefusal?(
    owner: UploadSessionOwner<E>,
    reservationId?: string,
  ): Promise<boolean | undefined>;
  beginPublication(input: {
    readonly owner: UploadSessionOwner<E>;
    readonly now: Date;
    readonly rateWindowMs?: number;
  }): Promise<
    | 'started'
    | UploadSessionPublicationReservation
    | 'published'
    | 'limited'
    | 'in_progress'
    | 'missing'
  >;
  markPublished(input: {
    readonly owner: UploadSessionOwner<E>;
    readonly now: Date;
    readonly publicationStartedAt: Date;
    readonly imageUrl: string;
    readonly requestId?: string;
    readonly contentType?: C;
    readonly byteSize?: number;
    readonly reservationId?: string;
  }): Promise<P | 'revoked' | undefined>;
  releasePublication(
    owner: UploadSessionOwner<E>,
    publicationStartedAt: Date,
    reservationId?: string,
  ): Promise<void>;
  cleanupCandidates(input: {
    readonly now: Date;
    readonly orphanBefore: Date;
    readonly limit: number;
    readonly after?: { readonly createdAt: Date; readonly assetId: string };
  }): Promise<readonly UploadSessionCleanupCandidate<E>[]>;
  removeCleanupCandidate(
    candidate: UploadSessionCleanupCandidate<E>,
  ): Promise<boolean>;
  claimCleanupCandidate?(
    candidate: UploadSessionCleanupCandidate<E>,
    now: Date,
  ): Promise<UploadSessionCleanupCandidate<E> | undefined>;
}

export interface UploadSessionStoragePort<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
> {
  createUploadUrl(input: {
    readonly environment: E;
    readonly stagingKey: string;
    readonly contentType: C;
    readonly byteSize: number;
  }): Promise<{
    readonly url: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly expiresAt: Date;
  }>;
  inspectObject(
    input: {
      readonly environment: E;
      readonly stagingKey: string;
      readonly contentType?: C;
      readonly byteSize: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly contentType: C | undefined;
        readonly byteSize: number | undefined;
        readonly bytes: Uint8Array;
        readonly lastModified?: Date;
        readonly etag?: string;
      }
    | undefined
  >;
  publishObject(
    input: {
      readonly environment: E;
      readonly stagingKey: string;
      readonly publishedKey: string;
      readonly contentType: C;
      readonly bytes: Uint8Array;
      readonly byteSize?: number;
    },
    signal?: AbortSignal,
  ): Promise<void>;
  publicUrl(input: {
    readonly environment: E;
    readonly publishedKey: string;
  }): string;
  /** Features with more than one staged key replace the refusal cleanup here. */
  deleteRefusedObject?(
    intent: UploadSessionIntent<C, E>,
    signal: AbortSignal,
  ): Promise<boolean>;
  deleteStagingObject(
    input: { readonly environment: E; readonly stagingKey: string },
    signal?: AbortSignal,
  ): Promise<void>;
  deletePublishedObject(
    input: { readonly environment: E; readonly publishedKey: string },
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface UploadSessionServicePort<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
  P extends PublishedUploadSession<C, E> = PublishedUploadSession<C, E>,
> {
  create(input: {
    readonly context: RequestContext;
    readonly contentType: string;
    readonly byteSize: number;
  }): Promise<UploadSessionGrant<C>>;
  refresh(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<UploadSessionGrant<C>>;
  complete(input: {
    readonly context: RequestContext;
    readonly assetId: string;
  }): Promise<P>;
}
