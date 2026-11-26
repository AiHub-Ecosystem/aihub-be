import type { AppError } from '@/common/errors/app-error';

export type UploadSessionVerification =
  | { readonly kind: 'sanitized'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large' }
  | undefined;

export interface UploadSessionVerificationLease {
  release(): void;
}

/**
 * The per-feature residue of an upload lifecycle: policy values, identity
 * rules, verification, and the feature's own error vocabulary. The core owns
 * transitions; no method here may reach into a feature module.
 */
export interface UploadSessionPolicy {
  readonly maxBytes: number;
  readonly intentTtlMs: number;
  readonly rateWindowMs: number;
  readonly orphanGraceMs: number;
  isContentType(value: string): boolean;
  isAssetId(value: string): boolean;
  stagingKey(assetId: string): string;
  publishedKey(assetId: string): string;
  reserveVerification(): UploadSessionVerificationLease;
  verify(input: {
    readonly contentType: string;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
    readonly lease: UploadSessionVerificationLease;
  }): Promise<UploadSessionVerification>;
  invalidRequest(): AppError;
  payloadTooLarge(): AppError;
  rateLimited(): AppError;
  storageUnavailable(message?: string): AppError;
  notFound(): AppError;
}
