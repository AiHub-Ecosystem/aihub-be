import { uniquePostgresProbes } from './health.module';
import type { ReadinessProbe } from './readiness-probes';

describe('uniquePostgresProbes', () => {
  it('keeps one existing-pool probe per configured URL and preserves unconfigured roles', () => {
    const probes: ReadinessProbe[] = [
      {
        name: 'runtime-postgres',
        databaseUrl: 'postgres://db/app',
        check: async () => undefined,
      },
      {
        name: 'control-plane-write-postgres',
        databaseUrl: 'postgres://db/app',
        check: async () => undefined,
      },
      {
        name: 'control-plane-read-postgres',
        databaseUrl: 'postgres://reader/app',
        check: async () => undefined,
      },
      {
        name: 'missing-runtime-postgres',
        databaseUrl: undefined,
        check: async () => undefined,
      },
      {
        name: 'missing-control-plane-postgres',
        databaseUrl: undefined,
        check: async () => undefined,
      },
      { name: 'redis', check: async () => undefined },
    ];

    expect(uniquePostgresProbes(probes).map(({ name }) => name)).toEqual([
      'runtime-postgres',
      'control-plane-read-postgres',
      'missing-runtime-postgres',
      'missing-control-plane-postgres',
      'redis',
    ]);
  });
});
