import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';
import type { Pool } from 'pg';

import {
  API_HOST,
  assertNMinusOneGatePasses,
  jwt,
  request,
  resetNMinusOneDatabase,
  safeContainerError,
  waitReady,
} from './n-minus-one-runtime';

it('clears the database-scoped N-1 publication and replication slot', async () => {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: [{ active: false }] })
    .mockResolvedValue({ rows: [] });

  await resetNMinusOneDatabase({ query } as unknown as Pool);

  expect(query.mock.calls).toEqual([
    [
      'SELECT active FROM pg_replication_slots WHERE slot_name = $1',
      ['aihub_email_delivery'],
    ],
    ['SELECT pg_drop_replication_slot($1)', ['aihub_email_delivery']],
    ['DROP PUBLICATION IF EXISTS aihub_email_delivery'],
    ['DROP SCHEMA public CASCADE; CREATE SCHEMA public'],
  ]);
});

it('refuses to reset while the N-1 replication slot is active', async () => {
  const query = jest.fn().mockResolvedValue({ rows: [{ active: true }] });

  await expect(
    resetNMinusOneDatabase({ query } as unknown as Pool),
  ).rejects.toThrow('N-1 reset cannot drop an active email replication slot');
  expect(query).toHaveBeenCalledTimes(1);
});

it('passes the N-1 gate when no release hold is recorded', () => {
  expect(() => assertNMinusOneGatePasses([])).not.toThrow();
});

it('fails the N-1 gate when a release hold is recorded', () => {
  expect(() =>
    assertNMinusOneGatePasses(['RELEASE HOLD: incompatible JWKS']),
  ).toThrow('N-1 release compatibility failed (1 finding(s))');
});

it('redacts credentials from a container startup error', () => {
  expect(
    safeContainerError(
      'FATAL failed to connect postgres://user:secret@db:5432/app with Bearer abc and api_key=xyz',
    ),
  ).toBe(
    'FATAL failed to connect [database URL] with Bearer [redacted] and api_key=[redacted]',
  );
});

it('signs compatibility User Access JWTs with the requested audience', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

  expect(decodeJwt(jwt(privateKeyPem, 'aihub-user-api:production')).aud).toBe(
    'aihub-user-api:production',
  );
  expect(decodeJwt(jwt(privateKeyPem)).aud).toBe('aihub-user-api');
});

it('sends the configured production host to the isolated image', async () => {
  const server = createServer((incoming, outgoing) => {
    outgoing.writeHead(200, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ host: incoming.headers.host }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await expect(request(port, 'GET', '/')).resolves.toEqual({
      status: 200,
      body: { host: API_HOST },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('reports dependency state when an image never becomes ready', async () => {
  const server = createServer((incoming, outgoing) => {
    if (incoming.url === '/health') {
      outgoing.writeHead(200).end();
      return;
    }
    outgoing.writeHead(503, { 'content-type': 'application/json' });
    outgoing.end(
      JSON.stringify({
        status: 'error',
        dependencies: { 'runtime-postgres': 'down' },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    await expect(waitReady(port, 'previous image', 1)).rejects.toThrow(
      'dependencies":{"runtime-postgres":"down"}',
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
