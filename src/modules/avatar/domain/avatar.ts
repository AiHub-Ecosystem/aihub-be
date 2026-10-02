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

/** Every Avatar object key starts here. */
export const AVATAR_OBJECT_PREFIX = 'users/';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export const AVATAR_UPLOAD_URL_TTL_SECONDS = 5 * 60;

/**
 * Bound into the upload signature so storage serves it on every read
 * (ADR-0069). Each upload has a new URL, so caching never shows a stale image
 * under a current Avatar; the hour bounds how long a removed one lingers.
 */
export const AVATAR_CACHE_CONTROL = 'public, max-age=3600';

/**
 * A completion adopts only an object this young, measured from storage's own
 * last-modified time (ADR-0068). The sweep below waits far longer, so the two
 * can never act on the same object.
 */
export const AVATAR_COMPLETION_WINDOW_MS = 60 * 60 * 1000;

/** How old an unrecorded object must be before the sweep deletes it. */
export const AVATAR_SWEEP_GRACE_MS = 24 * 60 * 60 * 1000;

const ASSET_ID_PATTERN = /^ava_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Every key `avatarObjectKey` can produce, and nothing else. */
const OBJECT_KEY_PATTERN =
  /^users\/usr_[0-9A-HJKMNP-TV-Z]{26}\/avatar\/ava_[0-9A-HJKMNP-TV-Z]{26}\/original$/;

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

/** The sweep deletes only keys it recognises as its own layout. */
export function isAvatarObjectKey(value: string): boolean {
  return OBJECT_KEY_PATTERN.test(value);
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
