import { spawnSync } from 'node:child_process';

function executeCli(args: readonly string[]) {
  const { status, stdout, stderr } = spawnSync(
    process.execPath,
    ['scripts/cli/cli.mjs', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '' },
    },
  );
  return { status, stdout, stderr };
}

describe('operator commands CLI dispatch and validation', () => {
  describe('org:create', () => {
    it.each([
      ['empty options', []],
      ['unknown flag', ['--name', 'Acme', '--unknown', 'foo']],
      ['unexpected actor option', ['--name', 'Acme', '--actor', 'ops']],
      ['invalid rate limit', ['--name', 'Acme', '--rate-limit-rpm', 'abc']],
      ['invalid max concurrent', ['--name', 'Acme', '--max-concurrent', '-1']],
      ['invalid quota', ['--name', 'Acme', '--monthly-quota', '-50']],
      ['invalid hard stop', ['--name', 'Acme', '--hard-stop', 'invalid']],
    ])('refuses %s prior to database connection', (_, options) => {
      const result = executeCli(['org:create', ...options]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Command failed');
    });

    it('reaches database layer and fails operationally when unconfigured', () => {
      const result = executeCli(['org:create', '--name', 'Acme']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Command failed');
    });
  });

  describe('key:create', () => {
    it.each([
      ['missing all arguments', []],
      ['missing actor and name', ['--org', 'org_01']],
      ['missing org', ['--actor', 'ops-alice', '--name', 'k']],
      ['missing actor', ['--org', 'org_01', '--name', 'k']],
      ['missing name', ['--org', 'org_01', '--actor', 'ops-alice']],
      [
        'missing environment',
        ['--org', 'org_01', '--actor', 'ops-alice', '--name', 'k'],
      ],
      [
        'unsupported option',
        [
          '--org',
          'org_01',
          '--actor',
          'ops-alice',
          '--name',
          'k',
          '--extra',
          '1',
        ],
      ],
      [
        'unrecognized environment',
        [
          '--org',
          'org_01',
          '--actor',
          'ops-alice',
          '--name',
          'k',
          '--envs',
          'test_env',
        ],
      ],
      [
        'invalid internal boolean',
        [
          '--org',
          'org_01',
          '--actor',
          'ops-alice',
          '--name',
          'k',
          '--internal',
          'yes',
        ],
      ],
    ])('refuses %s prior to database connection', (_, options) => {
      const result = executeCli(['key:create', ...options]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Command failed');
    });

    it('names the valid environments when --envs is missing', () => {
      const result = executeCli([
        'key:create',
        '--org',
        'org_01',
        '--actor',
        'ops-alice',
        '--name',
        'k',
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        '--envs is required and must be one of: development, staging, production, sandbox',
      );
    });

    it.each([
      ['a trailing --envs', ['--envs']],
      ['--envs followed by another option', ['--envs', '--internal', 'true']],
    ])(
      'names the valid environments when %s leaves --envs without a value',
      (_, tail) => {
        const result = executeCli([
          'key:create',
          '--org',
          'org_01',
          '--actor',
          'ops-alice',
          '--name',
          'k',
          ...tail,
        ]);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(
          '--envs is required and must be one of: development, staging, production, sandbox',
        );
      },
    );

    it('reaches database layer and fails operationally when unconfigured', () => {
      const result = executeCli([
        'key:create',
        '--org',
        'org_01',
        '--actor',
        'ops-alice',
        '--name',
        'k',
        '--envs',
        'production',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Command failed');
    });
  });

  describe('key:revoke', () => {
    it.each([
      ['missing all arguments', []],
      ['missing actor', ['--key', 'ak_01']],
      ['missing key', ['--actor', 'ops-alice']],
      [
        'unsupported option',
        ['--key', 'ak_01', '--actor', 'ops-alice', '--foo', 'bar'],
      ],
    ])('refuses %s prior to database connection', (_, options) => {
      const result = executeCli(['key:revoke', ...options]);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Command failed');
    });

    it('reaches database layer and fails operationally when unconfigured', () => {
      const result = executeCli([
        'key:revoke',
        '--key',
        'ak_01',
        '--actor',
        'ops-alice',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Command failed');
    });
  });
});
