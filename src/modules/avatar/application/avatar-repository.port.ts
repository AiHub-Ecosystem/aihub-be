import type { Avatar } from '@/modules/avatar/domain/avatar';

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
  findByUser(userId: string): Promise<Avatar | undefined>;
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
