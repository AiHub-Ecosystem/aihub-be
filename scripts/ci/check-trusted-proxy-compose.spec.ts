const { validateTrustedProxyCompose } =
  require('./check-trusted-proxy-compose.cjs') as {
    validateTrustedProxyCompose: (compose: unknown) => string[];
  };

describe('production trusted-proxy Compose alignment', () => {
  const config = () => ({
    networks: {
      backend: {
        ipam: {
          config: [{ subnet: '172.16.7.0/24', gateway: '172.16.7.1' }],
        },
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

  it('accepts app runtime values that match the pinned backend gateway', () => {
    expect(validateTrustedProxyCompose(config())).toHaveLength(4);
  });

  it('rejects a backend subnet or gateway change', () => {
    const compose = config();
    compose.networks.backend.ipam.config[0]!.gateway = '172.16.7.2';
    expect(() => validateTrustedProxyCompose(compose)).toThrow(
      /backend network/,
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
