import type { Avatar } from '@/modules/avatar/domain/avatar';

/**
 * One presigned upload URL an account holds and has not consumed yet. It is
 * the only durable record of an outstanding grant, so the number of open URLs
 * per account is a counted fact rather than an estimate (#374).
 */
export interface AvatarUploadGrantRecord {
  readonly assetId: string;
  readonly objectKey: string;
  readonly expiresAt: Date;
}
/**
 * `recorded` wrote the Avatar. `already_recorded` found this same asset already
 * recorded for the account, which is a repeated completion. `exists` means the
 * account already has a different Avatar.
 */
export type RecordAvatarResult =
  | { readonly kind: 'recorded'; readonly avatar: Avatar }
  | { readonly kind: 'already_recorded'; readonly avatar: Avatar }
  | { readonly kind: 'exists' };

/**
 * Durable, and at most one Avatar per account: the database enforces it. Every
 * change is conditional on the Avatar the caller last read, so two concurrent
 * changes cannot both apply.
 */
export interface AvatarRepositoryPort {
  /** Serializes completion's storage publication and record write per account. */
  withUserLock<T>(
    userId: string,
    operation: (repository: AvatarRepositoryPort) => Promise<T>,
  ): Promise<T>;
  findByUser(userId: string): Promise<Avatar | undefined>;
  /**
   * The account's grants that are still uncompleted and unexpired at `now`.
   * A grant past its URL lifetime cannot be used, so it holds no slot.
   */
  openUploadGrants(
    userId: string,
    now: Date,
  ): Promise<readonly AvatarUploadGrantRecord[]>;
  /**
   * Records a grant, then reports whether the account is within `limit` open
   * grants and `issuanceLimit` grants in the window. `false` means the caller
   * must not hand the URL out; the whole check and the write happen under one
   * per-account lock so concurrent requests cannot both pass.
   */
  grantUpload(
    grant: AvatarUploadGrantRecord & {
      readonly userId: string;
      readonly createdAt: Date;
    },
    limits: {
      readonly openLimit: number;
      readonly issuanceLimit: number;
      readonly issuanceWindowMs: number;
    },
  ): Promise<boolean>;
  /**
   * Drops the grant's open state when completion consumes it. Idempotent: a
   * grant already gone (expired, swept, or consumed twice) is not an error.
   * The issuance window still counts it, so consuming a slot never restores
   * issuance headroom.
   */
  consumeUploadGrant(userId: string, assetId: string): Promise<void>;
  /** Which of these object keys an Avatar record currently names. */
  recordedObjectKeys(
    objectKeys: readonly string[],
  ): Promise<ReadonlySet<string>>;
  /** Records an account's first Avatar. */
  record(avatar: Avatar): Promise<RecordAvatarResult>;
  /**
   * Swaps in `avatar` only while the account's record still names
   * `previousAssetId`; `false` when it no longer does.
   */
  replace(previousAssetId: string, avatar: Avatar): Promise<boolean>;
  /**
   * Removes the record only while it still names `assetId`; `false` when it no
   * longer does.
   */
  remove(userId: string, assetId: string): Promise<boolean>;
}

export const AVATAR_REPOSITORY = Symbol('AVATAR_REPOSITORY');
