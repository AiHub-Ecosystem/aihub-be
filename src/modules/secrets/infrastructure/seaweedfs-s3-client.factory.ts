import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { AppError, internalError } from '@/common/errors/app-error';

import { S3Client } from '@aws-sdk/client-s3';

import { setObjectStorageQueueSource } from '@/common/observability/metrics';
import {
  DEFAULT_SEAWEEDFS_ENDPOINT,
  DEFAULT_SEAWEEDFS_REGION,
} from '@/config/runtime-configuration';
import type { SeaweedFsRuntimeSecrets } from '@/modules/secrets/application/runtime-secret-provider.port';

const MAX_CONCURRENT_OBJECT_STORAGE_REQUESTS = 16;

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
    throw internalError('SeaweedFS S3 configuration is invalid');
  }

  // Upload routes share 10s across all steps/body reads; S3 gets 5s for response headers.
  // Sweeps have no waiting HTTP caller and allow 30s per call. Callers retry; the SDK does not.
  const operator = options.workload === 'operator';
  // 16 concurrent calls per process bounds shared-host storage load; excess calls fail fast.
  const httpAgent = new HttpAgent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_OBJECT_STORAGE_REQUESTS,
  });
  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    maxSockets: MAX_CONCURRENT_OBJECT_STORAGE_REQUESTS,
  });
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
  const client = new S3Client({
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
  let inFlight = 0;
  client.middlewareStack.add(
    (next) => async (args) => {
      if (inFlight >= MAX_CONCURRENT_OBJECT_STORAGE_REQUESTS) {
        throw new AppError({
          code: 'INTERNAL_ERROR',
          message: 'Object storage bulkhead exhausted',
          retryable: false,
          diagnostic: 'object_storage:bulkhead_exhausted',
        });
      }
      inFlight += 1;
      let holdPermitForBody = false;
      let released = false;
      const release = (): void => {
        if (!released) {
          released = true;
          inFlight -= 1;
        }
      };
      try {
        const result = await next(args);
        const body =
          typeof result.output === 'object' &&
          result.output !== null &&
          'Body' in result.output
            ? result.output.Body
            : undefined;
        if (
          body instanceof Readable &&
          !body.readableEnded &&
          !body.destroyed
        ) {
          holdPermitForBody = true;
          // GetObject resolves at headers while its body still owns a socket.
          void finished(body, { cleanup: true }).then(release, release);
        }
        return result;
      } finally {
        if (!holdPermitForBody) release();
      }
    },
    { step: 'finalizeRequest', name: 'objectStorageBulkhead', priority: 'low' },
  );
  return client;
}
