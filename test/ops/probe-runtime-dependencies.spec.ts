import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const { probeDependencyUrl, probeReadiness, probeRuntimeDependencies } =
  require('../../scripts/ops/probe-runtime-dependencies.cjs') as {
    probeDependencyUrl(
      value: string,
      timeoutMs?: number,
    ): Promise<{ ok: boolean; result: string }>;
    probeReadiness(fetchImpl?: typeof fetch): Promise<{
      name: string;
      ok: boolean;
      result: string;
    }>;
    probeRuntimeDependencies(options?: {
      env?: Record<string, string | undefined>;
      fetchImpl?: typeof fetch;
      connect?: (value: string) => Promise<{ ok: boolean; result: string }>;
    }): Promise<{ name: string; ok: boolean; result: string }[]>;
  };

describe('runtime dependency probe', () => {
  it('ships the probe in the runtime image despite the scripts build-context ignore', () => {
    const root = resolve(__dirname, '../..');
    const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
    const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');

    expect(dockerfile).toContain(
      '/app/scripts/ops/probe-runtime-dependencies.cjs ./scripts/ops/probe-runtime-dependencies.cjs',
    );
    expect(dockerignore).toContain('!scripts/ops/');
    expect(dockerignore).toContain(
      '!scripts/ops/probe-runtime-dependencies.cjs',
    );
  });

  it('checks private database and Redis readiness plus both configured downstreams', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: 'ok',
        dependencies: {
          'runtime-postgres': 'up',
          'control-plane-write-postgres': 'up',
          'control-plane-read-postgres': 'up',
          redis: 'up',
        },
      }),
    });
    const connect = jest
      .fn()
      .mockResolvedValue({ ok: true, result: 'TLS_CONNECTED' });

    const results = await probeRuntimeDependencies({
      env: {
        DOWNSTREAM_AI_WRITING_URL: 'https://writing.example/api',
        DOWNSTREAM_AI_SPEAKING_URL: 'https://speaking.example/api',
      },
      fetchImpl,
      connect,
    });

    expect(results).toEqual([
      { name: 'postgres-redis', ok: true, result: 'READY' },
      { name: 'ai-writing', ok: true, result: 'TLS_CONNECTED' },
      { name: 'ai-speaking', ok: true, result: 'TLS_CONNECTED' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/ready',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(connect).toHaveBeenCalledWith('https://writing.example/api');
    expect(connect).toHaveBeenCalledWith('https://speaking.example/api');
  });

  it('reports only safe dependency names and status when readiness fails', async () => {
    const result = await probeReadiness(
      jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({
          status: 'error',
          dependencies: {
            redis: 'down',
            'private-db-password': 'postgres://user:secret@internal/db',
          },
          error: 'raw response must stay hidden',
        }),
      }),
    );

    expect(result).toEqual({
      name: 'postgres-redis',
      ok: false,
      result: 'DOWN:redis',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('raw response');
  });

  it('requires explicit runtime Postgres and Redis checks in readiness', async () => {
    await expect(
      probeReadiness(
        jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({
            status: 'ok',
            dependencies: { 'unrelated-check': 'up' },
          }),
        }),
      ),
    ).resolves.toEqual({
      name: 'postgres-redis',
      ok: false,
      result: 'DEPENDENCY_STATUS',
    });
  });

  it('fails closed when downstream configuration is absent', async () => {
    const results = await probeRuntimeDependencies({
      env: {},
      fetchImpl: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', dependencies: { redis: 'up' } }),
      }),
      connect: jest.fn(),
    });

    expect(results.slice(1)).toEqual([
      { name: 'ai-writing', ok: false, result: 'CONFIG_MISSING' },
      { name: 'ai-speaking', ok: false, result: 'CONFIG_MISSING' },
    ]);
  });

  it('proves a configured HTTP dependency accepts a TCP connection without sending a request', async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not bind a TCP port');
    }

    try {
      await expect(
        probeDependencyUrl(`http://127.0.0.1:${address.port}`),
      ).resolves.toEqual({ ok: true, result: 'TCP_CONNECTED' });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
