const { validateProductionCompose } =
  require('./check-production-compose-logs.cjs') as {
    validateProductionCompose: (compose: unknown) => string[];
  };

describe('production Compose log bounds', () => {
  const boundedLogging = {
    driver: 'json-file',
    options: { 'max-size': '10m', 'max-file': '3' },
  };

  it('accepts every service with the configured rolling bounds', () => {
    expect(
      validateProductionCompose({
        services: {
          app: { logging: boundedLogging },
          'app-sandbox': { logging: boundedLogging },
        },
      }),
    ).toEqual(['app', 'app-sandbox']);
  });

  it('fails when a production service has no bound', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          app: { logging: boundedLogging },
          'new-service': {},
        },
      }),
    ).toThrow(/new-service.*logging/);
  });

  it('fails when a service uses a different driver', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          app: {
            logging: {
              driver: 'local',
              options: { 'max-size': '10m', 'max-file': '1' },
            },
          },
        },
      }),
    ).toThrow(/app.*json-file/);
  });

  it('fails when a service changes either size bound', () => {
    expect(() =>
      validateProductionCompose({
        services: {
          app: {
            logging: {
              driver: 'json-file',
              options: { 'max-size': '10m', 'max-file': '1' },
            },
          },
        },
      }),
    ).toThrow(/app.*max-file/);
  });

  it('fails when the Compose config has no services', () => {
    expect(() => validateProductionCompose({ services: {} })).toThrow(
      /no services/,
    );
  });
});
