import { operatorPostgresApplicationName } from './operator-postgres-application-name';

describe('operatorPostgresApplicationName', () => {
  const originalScope = process.env['AIHUB_RUNTIME_DATABASE_SCOPE'];

  afterEach(() => {
    if (originalScope === undefined) {
      delete process.env['AIHUB_RUNTIME_DATABASE_SCOPE'];
    } else {
      process.env['AIHUB_RUNTIME_DATABASE_SCOPE'] = originalScope;
    }
  });

  it.each(['production', 'sandbox'] as const)(
    'labels the %s operator pool and role',
    (scope) => {
      process.env['AIHUB_RUNTIME_DATABASE_SCOPE'] = scope;

      expect(operatorPostgresApplicationName('control-plane')).toBe(
        `aihub-be:${scope}:operator:control-plane`,
      );
    },
  );

  it('uses production when scope is omitted and unknown for an invalid scope', () => {
    delete process.env['AIHUB_RUNTIME_DATABASE_SCOPE'];
    expect(operatorPostgresApplicationName('runtime')).toBe(
      'aihub-be:production:operator:runtime',
    );

    process.env['AIHUB_RUNTIME_DATABASE_SCOPE'] = 'invalid';
    expect(operatorPostgresApplicationName('runtime')).toBe(
      'aihub-be:unknown:operator:runtime',
    );
  });
});
