import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { API_HOST, request } from './n-minus-one-runtime';

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
