import { once } from 'node:events';
import { type Server, createServer } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { getMetrics } from '@/common/observability/metrics';
import { S3AvatarStorage } from '@/modules/avatar/infrastructure/s3-avatar.storage';
import { createSeaweedFsS3Client } from '@/modules/secrets/infrastructure/seaweedfs-s3-client.factory';
import { S3SpeakingAudioAssetStorage } from '@/modules/speaking/infrastructure/s3-speaking-audio-asset.storage';
import { S3WritingChartUploadStorage } from '@/modules/writing/infrastructure/s3-writing-chart-upload.storage';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTransportConfigUpdater(
  value: unknown,
): value is (this: unknown, key: string, value: unknown) => void {
  return typeof value === 'function';
}

function isTransportConfigReader(
  value: unknown,
): value is (this: unknown) => unknown {
  return typeof value === 'function';
}

describe('SeaweedFS S3 transport', () => {
  let server: Server;
  let client: S3Client;

  function createClient(
    workload: 'request' | 'operator' = 'request',
  ): S3Client {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('missing port');
    const configured = createSeaweedFsS3Client({
      workload,
      credentials: {
        accessKeyId: 'fake-access',
        secretAccessKey: 'fake-secret',
      },
    });
    if (configured === undefined) throw new Error('missing S3 client');
    // Route the real SDK transport to a local stub without relaxing the endpoint allowlist.
    configured.middlewareStack.add(
      (next) => async (args) => {
        Object.assign(args.request ?? {}, {
          protocol: 'http:',
          hostname: '127.0.0.1',
          port: address.port,
        });
        return next(args);
      },
      { step: 'build', name: 'localStorageStub' },
    );
    return configured;
  }

  function configureTransport(key: string, value: unknown): void {
    const handler = client.config.requestHandler;
    if (!('updateHttpClientConfig' in handler)) {
      throw new Error('expected Node HTTP handler');
    }
    const update: unknown = Reflect.get(handler, 'updateHttpClientConfig');
    if (!isTransportConfigUpdater(update)) {
      throw new Error('expected Node HTTP handler');
    }
    update.call(handler, key, value);
  }

  beforeEach(async () => {
    server = createServer(() => undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    client = createClient();
  });

  afterEach(async () => {
    client?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fails a connected store that never answers instead of merely warning or retrying', async () => {
    configureTransport('requestTimeout', 80);
    const started = performance.now();
    await expect(
      new S3AvatarStorage(client, {
        bucket: 'aihub-user-assets',
      }).describeObject(
        'users/usr_test/avatar/ava_test/original',
        AbortSignal.timeout(1_500),
      ),
    ).rejects.toMatchObject({
      httpStatus: 503,
      diagnostic: 'object_storage:request_timeout',
      cause: {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
        $metadata: { attempts: 1 },
      },
    });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('bounds a connection that never finishes resolving', async () => {
    client.middlewareStack.remove('localStorageStub');
    configureTransport('connectionTimeout', 80);
    configureTransport(
      'httpsAgent',
      new HttpsAgent({ lookup: () => undefined }),
    );
    const failure: unknown = await new S3AvatarStorage(client, {
      bucket: 'aihub-user-assets',
    })
      .describeObject(
        'users/usr_test/avatar/ava_test/original',
        AbortSignal.timeout(1_500),
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toMatchObject({
      httpStatus: 503,
      diagnostic: 'object_storage:connection_timeout',
      cause: {
        name: 'TimeoutError',
        $metadata: { attempts: 1 },
      },
    });
    if (!isRecord(failure) || !isRecord(failure.cause)) {
      throw new Error('expected a timeout cause');
    }
    expect(failure.cause.message).toContain('did not establish a connection');
  });

  it('fails a refused connection immediately with a retryable 503', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      new S3AvatarStorage(client, {
        bucket: 'aihub-user-assets',
      }).describeObject(
        'users/usr_test/avatar/ava_test/original',
        AbortSignal.timeout(1_500),
      ),
    ).rejects.toMatchObject({
      httpStatus: 503,
      retryable: true,
      diagnostic: 'object_storage:connection_refused',
    });
    expect(await getMetrics()).toContain(
      'aihub_object_storage_failures_total{reason="connection_refused"}',
    );
  });

  it.each(['request', 'operator'] as const)(
    'uses the %s budget without automatic retries',
    async (workload) => {
      client.destroy();
      client = createClient(workload);
      server.on('request', (_request, response) => response.end());
      await client.send(new HeadObjectCommand({ Bucket: 'test', Key: 'test' }));
      const handler = client.config.requestHandler;
      if (!('httpHandlerConfigs' in handler)) {
        throw new Error('expected Node HTTP handler');
      }
      const readConfig: unknown = Reflect.get(handler, 'httpHandlerConfigs');
      if (!isTransportConfigReader(readConfig)) {
        throw new Error('expected Node HTTP handler');
      }
      const config: unknown = readConfig.call(handler);
      if (!isRecord(config)) throw new Error('expected HTTP handler settings');
      expect(config).toMatchObject({
        connectionTimeout: workload === 'request' ? 1_000 : 3_000,
        requestTimeout: workload === 'request' ? 5_000 : 30_000,
        throwOnRequestTimeout: true,
      });
      expect(config.httpAgent).toHaveProperty('maxSockets', 16);
      expect(config.httpsAgent).toHaveProperty('maxSockets', 16);
      expect(await client.config.maxAttempts()).toBe(1);
    },
  );

  it('bounds the body read even after the store has returned its headers', async () => {
    server.on('request', (request, response) => {
      response.writeHead(request.method === 'HEAD' ? 200 : 206, {
        'Content-Length': '100',
        ETag: '"version"',
        'Content-Type': 'image/png',
        'Content-Range': 'bytes 0-99/100',
      });
      if (request.method === 'HEAD') response.end();
      else response.write('a');
    });
    const adapter = new S3WritingChartUploadStorage(client, {
      environment: 'sandbox',
      stagingBucket: 'aihub-sandbox-writing-chart-staging',
    });
    await expect(
      adapter.inspectObject(
        {
          environment: 'sandbox',
          stagingKey: 'writing-charts/chart_01J00000000000000000000001/staging',
          byteSize: 100,
        },
        AbortSignal.timeout(100),
      ),
    ).rejects.toMatchObject({
      httpStatus: 503,
      diagnostic: 'object_storage:deadline',
    });
  });

  it('exposes queued calls and releases them when the caller cancels', async () => {
    const abort = new AbortController();
    let connected = 0;
    let ready: () => void = () => undefined;
    const occupied = new Promise<void>((resolve) => {
      ready = resolve;
    });
    server.on('request', () => {
      if (++connected === 16) ready();
    });
    const calls = Array.from({ length: 17 }, () =>
      client.send(new HeadObjectCommand({ Bucket: 'test', Key: 'test' }), {
        abortSignal: abort.signal,
      }),
    );
    const settled = Promise.allSettled(calls);
    try {
      await occupied;
      expect(await getMetrics()).toContain(
        'aihub_object_storage_queued_requests 1',
      );
    } finally {
      abort.abort();
      await settled;
    }
    expect((await settled).every((call) => call.status === 'rejected')).toBe(
      true,
    );
  });

  it.each(['avatar', 'speaking', 'writing'] as const)(
    '%s stops at the caller deadline and returns a safe retryable error',
    async (kind) => {
      const signal = AbortSignal.abort(
        new DOMException('expired', 'TimeoutError'),
      );
      const operation =
        kind === 'avatar'
          ? new S3AvatarStorage(client, {
              bucket: 'aihub-user-assets',
            }).describeObject('users/usr_test/avatar/ava_test/original', signal)
          : kind === 'speaking'
            ? new S3SpeakingAudioAssetStorage(client, {
                sandboxBucket: 'aihub-sandbox-speaking-recordings',
              }).describeObject(
                {
                  environment: 'sandbox',
                  objectKey:
                    'orgs/org_01J00000000000000000000001/speaking/aud_01J00000000000000000000001/original',
                },
                signal,
              )
            : new S3WritingChartUploadStorage(client, {
                environment: 'sandbox',
                stagingBucket: 'aihub-sandbox-writing-chart-staging',
              }).inspectObject(
                {
                  environment: 'sandbox',
                  stagingKey:
                    'writing-charts/chart_01J00000000000000000000001/staging',
                  byteSize: 100,
                },
                signal,
              );
      await expect(operation).rejects.toMatchObject({
        httpStatus: 503,
        retryable: true,
        // The hint is spread over [1 s, 2 s) (#1352).
        retryAfterMs: expect.closeTo(1_499.5, -3) as unknown,
        diagnostic: 'object_storage:deadline',
      });
    },
  );
});
