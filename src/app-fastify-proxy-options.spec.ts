import Fastify from 'fastify';

import { createAppFastifyProxyOptions } from './app-fastify-proxy-options';
import { loadRuntimeConfiguration } from './config/runtime-configuration';

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
