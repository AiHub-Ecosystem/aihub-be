const { validateTrustedProxyCompose } =
  require('./check-trusted-proxy-compose.cjs') as {
    validateTrustedProxyCompose: (compose: unknown) => string[];
  };

describe('production trusted-proxy Compose alignment', () => {
  const config = () => ({
    networks: {
      backend: {
        external: true,
        name: 'aihub-production_backend',
      },
    },
    services: Object.fromEntries(
      ['app', 'app-slot-b', 'app-sandbox', 'app-sandbox-slot-b'].map((name) => [
        name,
        {
          networks: { backend: {} },
          environment: { AIHUB_TRUSTED_PROXY_IP: '172.16.7.1' },
        },
      ]),
    ),
  });

  it('accepts the shared externally managed network and matching app IPs', () => {
    expect(validateTrustedProxyCompose(config())).toHaveLength(4);
  });

  it('rejects a Compose-managed backend network', () => {
    const compose = config();
    compose.networks.backend.external = false;
    expect(() => validateTrustedProxyCompose(compose)).toThrow(
      /backend network.*externally managed/,
    );
  });

  it('rejects a different external backend network name', () => {
    const compose = config();
    compose.networks.backend.name = 'aihub-other_backend';
    expect(() => validateTrustedProxyCompose(compose)).toThrow(
      /backend network.*aihub-production_backend/,
    );
  });

  it('rejects an app value that differs from the backend gateway', () => {
    const compose = config();
    compose.services['app-sandbox']!.environment.AIHUB_TRUSTED_PROXY_IP =
      '172.16.7.2';
    expect(() => validateTrustedProxyCompose(compose)).toThrow(
      /app-sandbox.*gateway/,
    );
  });

  it('rejects an app service detached from the backend network', () => {
    const compose = config();
    Reflect.deleteProperty(compose.services.app!.networks, 'backend');
    expect(() => validateTrustedProxyCompose(compose)).toThrow(
      /app.*backend network/,
    );
  });
});
