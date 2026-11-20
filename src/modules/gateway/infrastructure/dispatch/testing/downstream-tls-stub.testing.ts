import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The self-signed fixture credentials a local HTTPS or HTTP/2 stub serves. */
export const tlsStubCredentials = {
  key: createPrivateKey({
    key: readFileSync(
      join(process.cwd(), 'test/fixtures/downstream-http2/server-key.der'),
    ),
    format: 'der',
    type: 'pkcs8',
  }).export({ format: 'pem', type: 'pkcs8' }),
  cert: Buffer.from(
    readFileSync(
      join(process.cwd(), 'test/fixtures/downstream-http2/server-cert.fixture'),
      'utf8',
    ),
    'base64',
  ).toString('utf8'),
};
