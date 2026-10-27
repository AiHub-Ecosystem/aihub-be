import process from 'node:process';

import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { createCliRuntimeSecretProvider } from './runtime-secret-provider';

/**
 * The one SeaweedFS client every operator command builds: endpoint and region
 * from the process environment, credentials from the runtime secret provider.
 */
export function createCliSeaweedFsClient() {
  return createSeaweedFsS3Client({
    workload: 'operator',
    endpoint: process.env.SEAWEEDFS_ENDPOINT_URL,
    region: process.env.SEAWEEDFS_REGION,
    credentials: createCliRuntimeSecretProvider().getSnapshot().seaweedfs,
  });
}
