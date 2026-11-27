import type { AppError } from '@/common/errors/app-error';
import type { RequestContext } from '@/common/request-context/request-context';
import type {
  UploadSessionEnvironment,
  UploadSessionOwner,
} from '@/modules/uploads/domain/upload-session';

/**
 * The per-feature residue of an upload lifecycle: policy values, identity
 * rules, and the feature's own error vocabulary. Byte verification lives in
 * `UploadSessionVerificationPort` and is supplied only by features whose
 * storage produces bytes. The core owns transitions; no method here may reach
 * into a feature module.
 */
export interface UploadSessionPolicy<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
> {
  readonly maxBytes: number;
  readonly minBytes?: number;
  readonly intentTtlMs: number;
  readonly rateWindowMs: number;
  readonly orphanGraceMs: number;
  owner(context: RequestContext, assetId: string): UploadSessionOwner<E>;
  isContentType(value: string): value is C;
  isAssetId(value: string): boolean;
  stagingKey(owner: UploadSessionOwner<E>): string;
  publishedKey(owner: UploadSessionOwner<E>): string;
  completionSignal?(signal: AbortSignal): AbortSignal;
  invalidRequest(): AppError;
  payloadTooLarge(): AppError;
  rateLimited(): AppError;
  storageUnavailable(message?: string): AppError;
  notFound(): AppError;
}
