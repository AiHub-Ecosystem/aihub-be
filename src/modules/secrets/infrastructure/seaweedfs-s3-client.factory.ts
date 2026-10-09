import { S3Client } from '@aws-sdk/client-s3';

import {
  DEFAULT_SEAWEEDFS_ENDPOINT,
  DEFAULT_SEAWEEDFS_REGION,
} from '@/config/runtime-configuration';
import type { SeaweedFsRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

export interface SeaweedFsS3ClientOptions {
  readonly endpoint?: string | undefined;
  readonly region?: string | undefined;
  readonly credentials?: SeaweedFsRuntimeSecrets | undefined;
}

/** One S3 client per composition root; consumers choose only their bucket. */
export function createSeaweedFsS3Client(
  options: SeaweedFsS3ClientOptions,
): S3Client | undefined {
  if (options.credentials === undefined) return undefined;

  const endpoint = options.endpoint ?? DEFAULT_SEAWEEDFS_ENDPOINT;
  const region = options.region ?? DEFAULT_SEAWEEDFS_REGION;
  if (endpoint !== DEFAULT_SEAWEEDFS_ENDPOINT || region.trim().length === 0) {
    throw new Error('SeaweedFS S3 configuration is invalid');
  }

  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    // Browser PUTs cannot satisfy an SDK placeholder checksum created before upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
    },
  });
}
