import process from 'node:process';

import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { S3WritingChartUploadStorage } from '@/modules/writing/infrastructure/s3-writing-chart-upload.storage';
import type { WritingChartEnvironment } from '@/modules/writing/public/chart-revocation';
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

/**
 * The Writing chart storage the revoke and sweep commands share: the operator
 * SeaweedFS client plus the optional bucket and public-URL overrides.
 */
export function createCliWritingChartStorage(
  environment: WritingChartEnvironment,
): S3WritingChartUploadStorage {
  const { env } = process;
  return new S3WritingChartUploadStorage(createCliSeaweedFsClient(), {
    environment,
    ...(env.SEAWEEDFS_CHART_STAGING_BUCKET === undefined
      ? {}
      : { stagingBucket: env.SEAWEEDFS_CHART_STAGING_BUCKET }),
    ...(env.SEAWEEDFS_CHART_PUBLIC_BUCKET === undefined
      ? {}
      : { publicBucket: env.SEAWEEDFS_CHART_PUBLIC_BUCKET }),
    ...(env.AIHUB_CHART_PUBLIC_BASE_URL === undefined
      ? {}
      : { publicBaseUrl: env.AIHUB_CHART_PUBLIC_BASE_URL }),
  });
}
