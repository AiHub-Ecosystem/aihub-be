import process from 'node:process';

import { S3SpeakingAudioAssetStorage } from '@/modules/speaking/infrastructure/s3-speaking-audio-asset.storage';
import { createCliSeaweedFsClient } from './seaweedfs-client';

/**
 * The Speaking audio asset storage the upload sweep command builds: the
 * operator SeaweedFS client plus the per-scope asset bucket.
 */
export function createCliSpeakingAudioAssetStorage(): S3SpeakingAudioAssetStorage {
  const bucket = process.env.SEAWEEDFS_AUDIO_ASSET_BUCKET;
  return new S3SpeakingAudioAssetStorage(
    createCliSeaweedFsClient(),
    process.env.AIHUB_RUNTIME_DATABASE_SCOPE === 'sandbox'
      ? bucket === undefined
        ? {}
        : { sandboxBucket: bucket }
      : bucket === undefined
        ? {}
        : { productionBucket: bucket },
  );
}
