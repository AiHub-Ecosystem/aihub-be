import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { S3Client } from '@aws-sdk/client-s3';

import { setObjectStorageQueueSource } from '@/common/observability/metrics';
import {
  DEFAULT_SEAWEEDFS_ENDPOINT,
  DEFAULT_SEAWEEDFS_REGION,
} from '@/config/runtime-configuration';
import type { SeaweedFsRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

export interface SeaweedFsS3ClientOptions {
  readonly endpoint?: string | undefined;
  readonly region?: string | undefined;
  readonly credentials?: SeaweedFsRuntimeSecrets | undefined;
  readonly workload?: 'request' | 'operator';
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

  // Upload routes share 10s across all steps/body reads; S3 gets 5s to response headers, including queue time.
  // Sweeps have no waiting HTTP caller and allow 30s per call. Callers retry; the SDK does not.
  const operator = options.workload === 'operator';
  // 16 concurrent calls per process bounds shared-host storage load; excess calls queue within their deadline.
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 16 });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 16 });
  setObjectStorageQueueSource(() =>
    [httpAgent, httpsAgent].reduce(
      (total, agent) =>
        total +
        Object.values(agent.requests).reduce(
          (queued, requests) => queued + (requests?.length ?? 0),
          0,
        ),
      0,
    ),
  );
  return new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    maxAttempts: 1,
    retryMode: 'standard',
    requestHandler: {
      httpAgent,
      httpsAgent,
      connectionTimeout: operator ? 3_000 : 1_000,
      requestTimeout: operator ? 30_000 : 5_000,
      throwOnRequestTimeout: true,
    },
    // Browser PUTs cannot satisfy an SDK placeholder checksum created before upload.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
    },
  });
}
