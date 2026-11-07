export type AvatarStorageEnvironment = 'production' | 'sandbox';

export const AVATAR_STAGING_BUCKETS: Record<AvatarStorageEnvironment, string> =
  {
    production: 'aihub-user-asset-staging',
    sandbox: 'aihub-sandbox-user-asset-staging',
  };
