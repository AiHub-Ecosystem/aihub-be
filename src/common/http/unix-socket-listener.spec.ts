import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';

import { createAppFastifyProxyOptions } from '@/app-fastify-proxy-options';
import { prepareSocketListener } from './unix-socket-listener';

// A Windows named pipe is not a file, so it cannot be left stale or chmod-ed.
const describePosix = process.platform === 'win32' ? describe.skip : describe;

function socketPathFor(name: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\aihub-${name}-${process.pid}`
    : join(tmpdir(), `aihub-${name}-${process.pid}.sock`);
}

function call(
  socketPath: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(
      { socketPath, path: '/caller-ip', headers, agent: false },
      (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        response.on('end', () =>
          resolve({ statusCode: response.statusCode ?? 0, body }),
        );
      },
    ).on('error', reject);
  });
}

async function startApp(socketPath: string) {
  const app = Fastify(createAppFastifyProxyOptions('172.16.7.1', socketPath));
  app.get('/caller-ip', (request) => ({ ip: request.ip ?? null }));
  const openSocket = prepareSocketListener(app, socketPath);
  await app.listen({ host: '127.0.0.1', port: 0 });
  await openSocket();
  return app;
}

describe('Unix socket listener', () => {
  it('serves the app on the socket and resolves the caller from the proxy-appended entry', async () => {
    const socketPath = socketPathFor('serve');
    const app = await startApp(socketPath);

    try {
      const response = await call(socketPath, {
        'x-forwarded-for': '6.6.6.6, 198.51.100.7',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ ip: '198.51.100.7' });
    } finally {
      await app.close();
    }
  });

  it('stops accepting connections when the app closes', async () => {
    const socketPath = socketPathFor('close');
    const app = await startApp(socketPath);
    await call(socketPath, { 'x-forwarded-for': '198.51.100.7' });

    await app.close();

    // A new connection (no keep-alive reuse) finds no listener.
    await expect(call(socketPath)).rejects.toHaveProperty('code');
  });
});

describePosix('Unix socket file', () => {
  it('preserves a regular file at the configured socket path', async () => {
    const socketPath = socketPathFor('regular-file');
    writeFileSync(socketPath, 'preserve this file');
    const app = Fastify(createAppFastifyProxyOptions('172.16.7.1', socketPath));
    const openSocket = prepareSocketListener(app, socketPath);
    await app.listen({ host: '127.0.0.1', port: 0 });

    try {
      await expect(openSocket()).rejects.toThrow(
        'Refusing to replace non-socket path',
      );
      expect(readFileSync(socketPath, 'utf8')).toBe('preserve this file');
    } finally {
      await app.close();
      await rm(socketPath, { force: true });
    }
  });

  it('is limited to its owner and group', async () => {
    const socketPath = socketPathFor('mode');
    const app = await startApp(socketPath);

    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    } finally {
      await app.close();
    }
  });
});
