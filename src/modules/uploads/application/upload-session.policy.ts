import type { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  UploadSessionIntent,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

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
  readonly minBytes?: number;
  readonly intentTtlMs: number;
  readonly rateWindowMs: number;
  readonly orphanGraceMs: number;
  owner(context: RequestContext, assetId: string): UploadSessionOwner;
  isContentType(value: string): boolean;
  isAssetId(value: string): boolean;
  stagingKey(owner: UploadSessionOwner): string;
  publishedKey(owner: UploadSessionOwner): string;
  completionSignal?(signal: AbortSignal): AbortSignal;
  /** Features with more than one staged key replace the refusal cleanup here. */
  deleteOnRefusal?(
    intent: UploadSessionIntent,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** Features whose storage is HEAD-only replace the byte-equality rule here. */
  invalidStoredObject?(
    stored: {
      readonly contentType: string | undefined;
      readonly byteSize: number | undefined;
      readonly bytes: Uint8Array;
    },
    intent: UploadSessionIntent,
  ): AppError | undefined;
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
