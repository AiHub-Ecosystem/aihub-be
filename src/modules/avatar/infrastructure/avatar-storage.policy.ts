export type AvatarStorageEnvironment = 'production' | 'sandbox';

/**
 * The one Avatar bucket each runtime scope may use (ADR-0068). A deployment
 * named anything else has no Avatar storage rather than the other
 * deployment's bucket, whose daily sweep would delete its live Avatars (#428).
 */
export const AVATAR_BUCKETS: Record<AvatarStorageEnvironment, string> = {
  production: 'aihub-user-assets',
  sandbox: 'aihub-sandbox-user-assets',
};

/** The bucket only when it is this scope's own, so a wrong value is unset. */
export function avatarBucketFor(
  environment: AvatarStorageEnvironment,
  bucket: string | undefined,
): string | undefined {
  const value = (bucket ?? '').trim();
  return value === AVATAR_BUCKETS[environment] ? value : undefined;
}

export const AVATAR_STAGING_BUCKETS: Record<AvatarStorageEnvironment, string> =
  {
    production: 'aihub-user-asset-staging',
    sandbox: 'aihub-sandbox-user-asset-staging',
  };
