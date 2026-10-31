import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, get } from 'node:http';
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

type ListenerTarget = { socketPath: string } | { host: string; port: number };

function call(
  target: ListenerTarget,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    get(
      { ...target, path: '/caller-ip', headers, agent: false },
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
  if (process.platform === 'win32' && process.versions.bun !== undefined) {
    // shortcut: Bun on Windows cannot listen on named pipes; use loopback TCP until it can.
    const server = createServer((request, response) => {
      app.routing(request, response);
    });
    app.addHook('onClose', (_instance, done) => {
      server.close(done);
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('missing local listener address');
    }
    return { app, target: { host: '127.0.0.1', port: address.port } };
  }
  const openSocket = prepareSocketListener(app, socketPath);
  await app.listen({ host: '127.0.0.1', port: 0 });
  await openSocket();
  return { app, target: { socketPath } };
}

describe('local listener', () => {
  it('serves the app and resolves the caller from the proxy-appended entry', async () => {
    const socketPath = socketPathFor('serve');
    const { app, target } = await startApp(socketPath);

    try {
      const response = await call(target, {
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
    const { app, target } = await startApp(socketPath);
    await call(target, { 'x-forwarded-for': '198.51.100.7' });

    await app.close();

    // A new connection (no keep-alive reuse) finds no listener.
    await expect(call(target)).rejects.toHaveProperty('code');
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
    const { app } = await startApp(socketPath);

    try {
      expect(statSync(socketPath).mode & 0o777).toBe(0o660);
    } finally {
      await app.close();
    }
  });
});
