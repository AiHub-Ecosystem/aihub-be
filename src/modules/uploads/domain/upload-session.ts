export type UploadSessionEnvironment = 'production' | 'sandbox';

export type UploadSessionOwner = {
  readonly assetId: string;
  readonly organizationId?: string;
  readonly endUserId: string;
  readonly environment: UploadSessionEnvironment;
};

export interface UploadSessionIntent extends UploadSessionOwner {
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly status: 'open' | 'rejected' | 'publishing';
}

export interface PublishedUploadSession
  extends Omit<UploadSessionIntent, 'status'> {
  readonly status: 'published' | 'deleted';
  readonly publishedAt: Date;
  readonly retentionExpiresAt?: Date;
  readonly imageUrl: string;
  readonly created?: boolean;
}

export type UploadSessionLookup =
  | { readonly kind: 'intent'; readonly intent: UploadSessionIntent }
  | { readonly kind: 'asset'; readonly asset: PublishedUploadSession }
  | { readonly kind: 'missing' };

export interface UploadSessionCleanupCandidate {
  readonly kind: 'intent' | 'asset';
  readonly assetId: string;
  readonly environment: UploadSessionEnvironment;
  readonly stagingKey: string;
  readonly publishedKey: string;
  readonly createdAt: Date;
}
