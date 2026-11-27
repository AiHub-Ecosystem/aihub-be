export type UploadSessionEnvironment = 'production' | 'sandbox';

export type UploadSessionOwner<E extends string = UploadSessionEnvironment> = {
  readonly assetId: string;
  readonly organizationId?: string;
  readonly endUserId: string;
  readonly environment: E;
};

export interface UploadSessionIntent<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
> extends UploadSessionOwner<E> {
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly contentType: C;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'open' | 'rejected' | 'publishing';
}

export interface PublishedUploadSession<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
> extends Omit<UploadSessionIntent<C, E>, 'status'> {
  readonly status: 'published' | 'deleted';
  readonly publishedAt: Date;
  readonly retentionExpiresAt?: Date;
  readonly imageUrl: string;
  readonly created?: boolean;
}

export type UploadSessionLookup<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
  P extends PublishedUploadSession<C, E> = PublishedUploadSession<C, E>,
> =
  | { readonly kind: 'intent'; readonly intent: UploadSessionIntent<C, E> }
  | { readonly kind: 'asset'; readonly asset: P }
  | { readonly kind: 'missing' };

export interface UploadSessionCleanupCandidate<
  E extends string = UploadSessionEnvironment,
> {
  readonly kind: 'intent' | 'asset' | 'reservation';
  readonly assetId: string;
  readonly candidateId?: string;
  readonly environment: E;
  readonly stagingKey?: string;
  readonly publishedKey: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date;
  readonly status?: 'open' | 'rejected' | 'active' | 'abandoned';
  readonly contentType?: string;
  readonly byteSize?: number;
  readonly organizationId?: string;
  readonly endUserId?: string;
  readonly lastCleanedAt?: Date;
  readonly orphanBefore?: Date;
  readonly reservationId?: string;
  readonly claimId?: string;
}
