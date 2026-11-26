import type { AppError } from '@/common/errors/app-error';

/** A storage-side check after staging that must run the core's refusal path. */
export class UploadSessionVerificationRefusal extends Error {
  constructor(readonly refusal: AppError) {
    super(refusal.message);
  }
}
