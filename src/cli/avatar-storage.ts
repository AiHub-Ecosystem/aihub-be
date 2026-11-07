import process from 'node:process';

import { S3AvatarStorage } from '@/modules/avatar/infrastructure/s3-avatar.storage';
import { createCliSeaweedFsClient } from './seaweedfs-client';

/**
 * The Avatar storage the sweep command builds: the operator SeaweedFS
 * client plus the optional user-asset bucket override.
 */
export function createCliAvatarStorage(): S3AvatarStorage {
  return new S3AvatarStorage(
    createCliSeaweedFsClient(),
    process.env.SEAWEEDFS_USER_ASSET_BUCKET === undefined
      ? {}
      : { bucket: process.env.SEAWEEDFS_USER_ASSET_BUCKET },
  );
}
