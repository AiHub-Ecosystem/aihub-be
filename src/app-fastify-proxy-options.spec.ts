import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';

import { createAppFastifyProxyOptions } from './app-fastify-proxy-options';
import { loadRuntimeConfiguration } from './config/runtime-configuration';

function isCallerIpResponse(
  value: unknown,
): value is { ip: string | null; ips: (string | null)[] } {
  if (typeof value !== 'object' || value === null || !('ip' in value)) {
    return false;
  }
  if (!('ips' in value)) return false;
  return (
    (typeof value.ip === 'string' || value.ip === null) &&
    Array.isArray(value.ips) &&
    value.ips.every((ip: unknown) => typeof ip === 'string' || ip === null)
  );
}

describe('Fastify proxy trust configuration', () => {
  it('uses the configured immediate peer and ignores forwarding from other peers', async () => {
    const configuration = loadRuntimeConfiguration({
      NODE_ENV: 'test',
      AIHUB_RUNTIME_SECRET_SOURCE: 'agent-file',
      AIHUB_RUNTIME_SECRETS_FILE: 'runtime-secrets.json',
      AIHUB_AUTH_MFA_SECRETS_FILE: 'auth-mfa-secrets.json',
      AIHUB_USER_ACCESS_ISSUER: 'https://api.test.invalid',
      AIHUB_TRUSTED_PROXY_IP: '172.16.7.1',
    });
    const app = Fastify(
      createAppFastifyProxyOptions(
        configuration.AIHUB_TRUSTED_PROXY_IP as string,
      ),
    );
    app.get('/caller-ip', (request) => ({ clientIp: request.ip }));
    await app.ready();

    try {
      const throughNginx = await app.inject({
        method: 'GET',
        url: '/caller-ip',
        remoteAddress: '172.16.7.1',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      const directPeer = await app.inject({
        method: 'GET',
        url: '/caller-ip',
        remoteAddress: '172.16.7.2',
        headers: { 'x-forwarded-for': '198.51.100.8' },
      });

      expect(throughNginx.json()).toEqual({ clientIp: '203.0.113.9' });
      expect(directPeer.json()).toEqual({ clientIp: '172.16.7.2' });
    } finally {
      await app.close();
    }
  });
});

describe('Fastify proxy trust over a local listener', () => {
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\aihub-proxy-trust-${process.pid}`
      : join(tmpdir(), `aihub-proxy-trust-${process.pid}.sock`);
  const bunOnWindows =
    process.platform === 'win32' && process.versions.bun !== undefined;
  let target: { socketPath: string } | { host: string; port: number } = {
    socketPath,
  };

  function request(headers: Record<string, string>) {
    return new Promise<{ ip: string | null; ips: (string | null)[] }>(
      (resolve, reject) => {
        get({ ...target, path: '/caller-ip', headers }, (response) => {
          let body = '';
          response.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          response.on('end', () => {
            const parsed: unknown = JSON.parse(body);
            if (!isCallerIpResponse(parsed)) {
              reject(new Error('invalid caller IP response'));
              return;
            }
            resolve(parsed);
          });
        }).on('error', reject);
      },
    );
  }

  it('resolves the caller to the entry the reverse proxy appended, never one the client wrote', async () => {
    const app = Fastify(createAppFastifyProxyOptions('172.16.7.1', socketPath));
    app.get('/caller-ip', (incoming) => ({
      ip: incoming.ip ?? null,
      ips: incoming.ips ?? [],
    }));
    if (bunOnWindows) {
      // shortcut: Bun on Windows cannot listen on named pipes; use loopback TCP until it can.
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      target = { host: '127.0.0.1', port: Number(new URL(address).port) };
    } else {
      await app.listen({ path: socketPath });
    }

    try {
      // nginx appends the address it saw to whatever the client sent.
      const forged = await request({
        'x-forwarded-for': '6.6.6.6, 198.51.100.7',
      });
      const single = await request({ 'x-forwarded-for': '198.51.100.7' });
      const absent = await request({});

      expect(forged.ip).toBe('198.51.100.7');
      expect(single.ip).toBe('198.51.100.7');
      // Unix peers have no address; the Bun TCP fallback resolves to loopback.
      expect(absent.ip).toBe(bunOnWindows ? '127.0.0.1' : null);
    } finally {
      await app.close();
    }
  });
});
