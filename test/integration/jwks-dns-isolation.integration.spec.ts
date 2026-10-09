import { createSocket } from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { createServer, get as httpGet } from 'node:http';

import { Argon2PasswordHasher } from '@/modules/auth/infrastructure/argon2-password.hasher';
import type {
  JwksCachePort,
  JwksCacheSnapshot,
  JwksRefreshLock,
} from '@/modules/identity/user-assertions/application/jwks-cache.port';
import { JwksKeyProvider } from '@/modules/identity/user-assertions/infrastructure/jwks-key-provider';

const cache: JwksCachePort = {
  getJwks: async (): Promise<JwksCacheSnapshot> => ({ generation: '0' }),
  setJwks: async () => undefined,
  tryAcquireRefresh: async (): Promise<JwksRefreshLock> => ({
    acquired: true,
    available: true,
  }),
  deleteJwks: async () => undefined,
};

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

describe('JWKS DNS isolation', () => {
  it('lets Argon2 and another Organization’s downstream hostname connect during a silent JWKS DNS query', async () => {
    const silentDns = createSocket('udp4');
    const downstreamPaths: string[] = [];
    const downstreamServer = createServer((request, response) => {
      downstreamPaths.push(request.url ?? '');
      response.end('connected');
    });
    await new Promise<void>((resolve) =>
      silentDns.bind(0, '127.0.0.1', resolve),
    );
    await listen(downstreamServer);

    try {
      const dnsAddress = silentDns.address();
      const downstreamAddress = downstreamServer.address();
      if (dnsAddress === null || typeof dnsAddress === 'string') {
        throw new Error('Silent DNS server did not bind');
      }
      if (downstreamAddress === null || typeof downstreamAddress === 'string') {
        throw new Error('Downstream test server did not bind');
      }

      let markDnsQuery: (() => void) | undefined;
      const dnsQuery = new Promise<void>((resolve) => {
        markDnsQuery = resolve;
      });
      silentDns.once('message', () => markDnsQuery?.());

      const provider = new JwksKeyProvider(cache, undefined, () => {
        const resolver = new Resolver({ timeout: 1_000, tries: 1 });
        resolver.setServers([`127.0.0.1:${dnsAddress.port}`]);
        return resolver;
      });
      let jwksSettled = false;
      const jwksValidation = provider
        .validateRemote({
          organizationId: 'org_jwks',
          url: 'https://jwks.silent.test/keys',
        })
        .then(
          () => {
            jwksSettled = true;
            return true;
          },
          () => {
            jwksSettled = true;
            return false;
          },
        );
      await dnsQuery;

      const downstreamResponse = new Promise<string>((resolve, reject) => {
        const request = httpGet(
          `http://localhost:${downstreamAddress.port}/organizations/org_other/downstream`,
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () => resolve(body));
          },
        );
        request.on('error', reject);
      });
      const [passwordHash, body] = await Promise.all([
        new Argon2PasswordHasher().hash('integration-password'),
        downstreamResponse,
      ]);

      expect(passwordHash).toMatch(/^\$argon2id\$/);
      expect(body).toBe('connected');
      expect(downstreamPaths).toEqual(['/organizations/org_other/downstream']);
      expect(jwksSettled).toBe(false);

      await jwksValidation;
      expect(jwksSettled).toBe(true);
    } finally {
      await close(downstreamServer);
      silentDns.close();
    }
  }, 15_000);
});
