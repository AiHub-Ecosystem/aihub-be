import process from 'node:process';

import {
  type AvatarStoragePort,
  createOperatorAvatarStorage,
} from '@/modules/avatar/public/avatar-sweep';
import { createCliSeaweedFsClient } from './seaweedfs-client';

/**
 * The Avatar storage the sweep command builds: the operator SeaweedFS
 * client plus the optional user-asset bucket override.
 */
export function createCliAvatarStorage(): AvatarStoragePort & {
  close(): Promise<void>;
} {
  return createOperatorAvatarStorage(createCliSeaweedFsClient(), {
    ...(process.env['SEAWEEDFS_USER_ASSET_BUCKET'] === undefined
      ? {}
      : { bucket: process.env['SEAWEEDFS_USER_ASSET_BUCKET'] }),
    environment:
      process.env['AIHUB_RUNTIME_DATABASE_SCOPE'] === 'sandbox'
        ? 'sandbox'
        : 'production',
    ...(process.env['SEAWEEDFS_USER_ASSET_STAGING_BUCKET'] === undefined
      ? {}
      : { stagingBucket: process.env['SEAWEEDFS_USER_ASSET_STAGING_BUCKET'] }),
  });
}
