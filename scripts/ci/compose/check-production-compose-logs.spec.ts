const { validateProductionCompose } =
  require('./check-production-compose-logs.cjs') as {
    validateProductionCompose: (compose: unknown) => string[];
  };

describe('production Compose log bounds', () => {
  const jsonFileLogging = {
    driver: 'json-file',
    options: { 'max-size': '10m', 'max-file': '3' },
  };
  const productionAppLogging = {
    driver: 'syslog',
    options: {
      'syslog-address': 'tcp://127.0.0.1:1514',
      'syslog-format': 'rfc5424micro',
      'cache-disabled': 'true',
      mode: 'non-blocking',
      'max-buffer-size': '1m',
      tag: 'aihub-production',
    },
  };
  const sandboxAppLogging = {
    ...productionAppLogging,
    options: { ...productionAppLogging.options, tag: 'aihub-sandbox' },
  };

  const validServices = {
    app: { logging: productionAppLogging },
    'app-slot-b': { logging: productionAppLogging },
    'app-sandbox': { logging: sandboxAppLogging },
    'app-sandbox-slot-b': { logging: sandboxAppLogging },
    'vault-agent': { logging: jsonFileLogging },
  };

  it('accepts app services on the local bounded syslog sink and others on json-file', () => {
    expect(validateProductionCompose({ services: validServices })).toEqual([
      'app',
      'app-sandbox',
      'app-sandbox-slot-b',
      'app-slot-b',
      'vault-agent',
    ]);
  });

  it('fails when a production service has no bound', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          ...validServices,
          'new-service': {},
        },
      }),
    ).toThrow(/new-service.*logging/);
  });

  it('fails when an app service does not use syslog', () => {
    expect(() =>
      validateProductionCompose({
        services: { ...validServices, app: { logging: jsonFileLogging } },
      }),
    ).toThrow(/app.*syslog/);
  });

  it('fails when an unrelated service uses syslog', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          ...validServices,
          'vault-agent': { logging: productionAppLogging },
        },
      }),
    ).toThrow(/vault-agent.*json-file/);
  });

  it('keeps the existing JSON-file size and generation bounds elsewhere', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          ...validServices,
          'vault-agent': {
            logging: {
              driver: 'json-file',
              options: { 'max-size': '10m', 'max-file': '2' },
            },
          },
        },
      }),
    ).toThrow(/vault-agent.*max-file=3/);
  });

  it('requires disabled cache and bounded non-blocking syslog delivery', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          ...validServices,
          app: {
            logging: {
              ...productionAppLogging,
              options: {
                ...productionAppLogging.options,
                'cache-disabled': 'false',
              },
            },
          },
        },
      }),
    ).toThrow(/app.*cache-disabled=true/);
  });

  it('requires all four application services to have age-managed logging', () => {
    const { 'app-sandbox-slot-b': _, ...services } = validServices;
    expect(() => validateProductionCompose({ services })).toThrow(
      /missing app service app-sandbox-slot-b/,
    );
  });

  it('fails when the Compose config has no services', () => {
    expect(() => validateProductionCompose({ services: {} })).toThrow(
      /no services/,
    );
  });
});
