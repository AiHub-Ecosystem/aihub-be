import process from 'node:process';

import { S3WritingChartUploadStorage } from '@/modules/writing/infrastructure/s3-writing-chart-upload.storage';
import type { WritingChartEnvironment } from '@/modules/writing/public/chart-revocation';
import { createCliSeaweedFsClient } from './seaweedfs-client';

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
