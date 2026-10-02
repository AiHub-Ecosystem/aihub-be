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

export interface AvatarRepositoryPort {
  findByUser(userId: string): Promise<Avatar | undefined>;
  /** Durable, and at most one per account: the database enforces it. */
  record(avatar: Avatar): Promise<RecordAvatarResult>;
}

export const AVATAR_REPOSITORY = Symbol('AVATAR_REPOSITORY');
