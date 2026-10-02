/**
 * Raster formats only. SVG is refused on purpose: it can carry script, and an
 * Avatar is shown to other people.
 */
export const AVATAR_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type AvatarContentType = (typeof AVATAR_CONTENT_TYPES)[number];

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AVATAR_UPLOAD_URL_TTL_SECONDS = 5 * 60;

const ASSET_ID_PATTERN = /^ava_[0-9A-HJKMNP-TV-Z]{26}$/;

export interface Avatar {
  readonly assetId: string;
  readonly userId: string;
  readonly objectKey: string;
  readonly contentType: AvatarContentType;
  readonly byteSize: number;
  readonly acceptedAt: Date;
}

export function isAvatarContentType(
  value: string | undefined,
): value is AvatarContentType {
  return AVATAR_CONTENT_TYPES.some((type) => type === value);
}

export function isAvatarAssetId(value: string): boolean {
  return ASSET_ID_PATTERN.test(value);
}

/**
 * The account owning an Avatar is provable from its key alone, and the key is
 * only ever built from the authenticated account, so no account can address
 * another's object (ADR-0068).
 */
export function avatarObjectKey(userId: string, assetId: string): string {
  return `users/${userId}/avatar/${assetId}/original`;
}
