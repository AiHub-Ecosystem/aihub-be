import type { AppError } from '@/common/errors/app-error';
import type {
  UploadSessionEnvironment,
  UploadSessionIntent,
} from '@/modules/uploads/domain/upload-session';

export type UploadSessionVerification =
  | { readonly kind: 'sanitized'; readonly bytes: Uint8Array }
  | { readonly kind: 'too_large' }
  | undefined;

export interface UploadSessionVerificationLease {
  release(): void;
}

/**
 * The byte-level part of an upload lifecycle, supplied only by features whose
 * storage actually reads staged bytes. Speaking's HEAD-only storage supplies no
 * port at all; the core publishes the object it staged without re-encoding it.
 */
export interface UploadSessionVerificationPort<
  C extends string = string,
  E extends string = UploadSessionEnvironment,
> {
  reserveVerification(): UploadSessionVerificationLease;
  verify(input: {
    readonly contentType: C;
    readonly bytes: Uint8Array;
    readonly signal: AbortSignal;
    readonly lease: UploadSessionVerificationLease;
  }): Promise<UploadSessionVerification>;
  invalidStoredObject?(
    stored: {
      readonly contentType: C | undefined;
      readonly byteSize: number | undefined;
      readonly bytes: Uint8Array;
    },
    intent: UploadSessionIntent<C, E>,
  ): AppError | undefined;
}

/** The default HEAD-vs-intent rule, owned by the core and reused by features. */
export function byteEqualityRefusal<C extends string, E extends string>(
  stored: {
    readonly contentType: C | undefined;
    readonly byteSize: number | undefined;
    readonly bytes: Uint8Array;
  },
  intent: UploadSessionIntent<C, E>,
  errors: {
    readonly maxBytes: number;
    invalidRequest(): AppError;
    payloadTooLarge(): AppError;
  },
): AppError | undefined {
  if (stored.byteSize !== undefined && stored.byteSize > errors.maxBytes) {
    return errors.payloadTooLarge();
  }
  if (
    stored.byteSize !== intent.byteSize ||
    stored.contentType !== intent.contentType ||
    stored.bytes.byteLength !== stored.byteSize
  ) {
    return errors.invalidRequest();
  }
  return undefined;
}
