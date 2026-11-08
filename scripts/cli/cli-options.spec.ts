import { execFile } from 'node:child_process';

import {
  CliUsageError,
  booleanOption,
  environmentOption,
  quotaOption,
} from './cli-options.cjs';
import {
  COMMAND_OPTIONS,
  CONTROL_PLANE_COMMANDS,
  MUTATING_COMMANDS,
  classifyDatabase,
  effectiveMaintenanceTime,
  isMutatingCommand,
  previewOperatorMutation,
  requireControlPlaneDatabase,
  requireStorageDeployment,
  requireTargetConfirmation,
} from './operator-safety.cjs';

function options(
  entries: Readonly<Record<string, string>> = {},
): Map<string, string> {
  return new Map(Object.entries(entries));
}

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: '' },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['scripts/cli/cli.mjs', ...args],
      { cwd: process.cwd(), env },
      (error, stdout, stderr) => {
        const code = error?.code;
        resolve({
          status: typeof code === 'number' ? code : error === null ? 0 : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

describe('COMMAND_OPTIONS', () => {
  it('declares an allow-list for every routed command', () => {
    const routed = [
      'org:create',
      'key:create',
      'key:revoke',
      'identity:set',
      'idempotency:cleanup',
      'quota:reconcile',
      'redis:ttl-audit',
      'org:suspend',
      'org:restore',
      'org:grant-entitlement',
      'org:attach-owner',
      'avatar:sweep',
      'speaking:audio-upload-sweep',
      'registrations:sweep',
      'notifications:sweep',
      'writing:chart-upload-sweep',
      'writing:chart-revoke',
      'usage:prune',
      'usage:report',
      'usage:major-report',
      'billing:statement',
      'billing:adjust',
      'user:disable',
      'user:restore',
      'session:revoke-all-refresh',
    ];
    for (const command of routed) {
      expect(COMMAND_OPTIONS[command]).toBeDefined();
    }
  });

  it('keeps the shared safety pair out of command-specific lists', () => {
    for (const options of Object.values(COMMAND_OPTIONS)) {
      expect(options).not.toContain('target');
      expect(options).not.toContain('dry-run');
    }
  });

  it('names the operator-visibility options every mutating preview reads', () => {
    expect(COMMAND_OPTIONS['org:create']).toContain('monthly-quota');
    expect(COMMAND_OPTIONS['key:create']).toContain('envs');
    expect(COMMAND_OPTIONS['identity:set']).toContain('public-keys-file');
  });
});

// Every Operator command rejects an unknown or case-variant option before
// touching the database (#925): the allow-list lives in operator-safety.cjs,
// enforced once in cli.mjs `main()`, so a mistyped option can never silently
// fall back to a default — e.g. `--env` on key:create issuing a Production
// key the operator meant to scope to Sandbox.
describe('operator CLI unknown options', () => {
  it.each([
    ['org:create', '--name', 'Acme', '--entitlement', 'writing'],
    ['org:create', '--name', 'Acme', '--monthly-quotas', '100'],
    [
      'key:create',
      '--org',
      'org_x',
      '--actor',
      'op',
      '--name',
      'k',
      '--env',
      'sandbox',
    ],
    [
      'key:create',
      '--org',
      'org_x',
      '--actor',
      'op',
      '--name',
      'k',
      '--ENVS',
      'sandbox',
    ],
    ['key:revoke', '--key', 'ak_x', '--actor', 'op', '--KEY', 'ak_y'],
    [
      'identity:set',
      '--org',
      'org_x',
      '--issuer',
      'https://issuer.example',
      '--jwks-url',
      'https://jwks.example',
      '--ISSUER',
      'https://other.example',
    ],
    [
      'idempotency:cleanup',
      '--target',
      'sandbox',
      '--dry-run',
      'true',
      '--unused',
      'x',
    ],
    [
      'billing:adjust',
      '--id',
      'badj_x',
      '--org',
      'org_x',
      '--month',
      '2026-01',
      '--operation',
      'op_x',
      '--requests',
      '5',
      '--reason',
      'correction',
      '--actor',
      'op',
      '--request-ids',
      'req_1',
      '--reason ',
      'correction',
    ],
    [
      'usage:report',
      '--from',
      '2026-01-01',
      '--to',
      '2026-02-01',
      '--FROM',
      '2026-01-01',
    ],
    ['usage:prune', '--dry-run', 'true', '--target', 'sandbox', '--limt', '5'],
    [
      'quota:reconcile',
      '--month',
      '2026-01',
      '--dry-run',
      'true',
      '--moonth',
      '2026-01',
    ],
  ])('rejects %s with an unknown option', async (command, ...args) => {
    const result = await runCli([command, ...args]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  });

  it('rejects an unknown command name', async () => {
    const result = await runCli(['bogus:command']);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Command failed');
  });

  it('still rejects an unknown option before any database work', async () => {
    const result = await runCli([
      'org:create',
      '--name',
      'Acme',
      '--entitlements',
      'writing',
      '--unknown',
      'yes',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain('DATABASE_URL');
  });
});
describe('quotaOption', () => {
  it('reads an absent quota as unlimited', () => {
    expect(quotaOption(options(), 'monthly-quota')).toBeNull();
  });

  it('reads a ceiling', () => {
    expect(
      quotaOption(options({ 'monthly-quota': '500' }), 'monthly-quota'),
    ).toBe(500);
  });

  // Freezing an organization without revoking its keys.
  it('accepts zero', () => {
    expect(
      quotaOption(options({ 'monthly-quota': '0' }), 'monthly-quota'),
    ).toBe(0);
  });

  it.each([
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['not a number', 'lots'],
    ['blank', '   '],
  ])('rejects a %s quota', (_label, value) => {
    expect(() => quotaOption(options({ q: value }), 'q')).toThrow(
      CliUsageError,
    );
  });
});

describe('booleanOption', () => {
  it('falls back when absent', () => {
    expect(booleanOption(options(), 'hard-stop')).toBe(false);
    expect(booleanOption(options(), 'hard-stop', true)).toBe(true);
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
  ])('reads %s', (value, expected) => {
    expect(booleanOption(options({ 'hard-stop': value }), 'hard-stop')).toBe(
      expected,
    );
  });

  // A quota that silently stops being enforced because someone wrote `yes` is
  // the failure this rejects.
  it.each([['yes'], ['1'], ['on'], ['']])(
    'rejects %s rather than reading it as a boolean',
    (value) => {
      expect(() =>
        booleanOption(options({ 'hard-stop': value }), 'hard-stop'),
      ).toThrow(CliUsageError);
    },
  );
});

describe('environmentOption', () => {
  it('defaults key creation to production', () => {
    expect(environmentOption(options(), 'envs')).toBe('production');
  });

  it.each(['development', 'staging', 'production', 'sandbox'])(
    'accepts %s',
    (environment) => {
      expect(environmentOption(options({ envs: environment }), 'envs')).toBe(
        environment,
      );
    },
  );

  // A new key has exactly one environment, so a list is refused outright.
  it.each([
    'unknown',
    '',
    'production,',
    'production,production',
    'sandbox,production',
    'development,staging',
  ])('rejects %s', (value) => {
    expect(() => environmentOption(options({ envs: value }), 'envs')).toThrow(
      CliUsageError,
    );
  });
});

describe('operator CLI safety', () => {
  it('classifies deployments from the database name', () => {
    expect(classifyDatabase('aihub')).toBe('production');
    expect(classifyDatabase('aihub_sandbox')).toBe('sandbox');
    expect(classifyDatabase('aihub_db_lane')).toBe('test');
    expect(classifyDatabase('unexpected')).toBe('unknown');
  });

  it('requires an exact confirmation for production and rejects a mismatch', () => {
    expect(() => requireTargetConfirmation('production', undefined)).toThrow(
      'production writes require --target production',
    );
    expect(() => requireTargetConfirmation('production', 'sandbox')).toThrow(
      'database target is production, not sandbox',
    );
    expect(() =>
      requireTargetConfirmation('production', 'production'),
    ).not.toThrow();
    expect(() => requireTargetConfirmation('test', 'production')).toThrow(
      'database target is test, not production',
    );
  });

  it('refuses control-plane writes against Sandbox and unknown databases', () => {
    expect(() => requireControlPlaneDatabase('sandbox')).toThrow(
      'control-plane commands require the Production control-plane database',
    );
    expect(() => requireControlPlaneDatabase('unknown')).toThrow(
      'control-plane commands require the Production control-plane database',
    );
    expect(() => requireControlPlaneDatabase('production')).not.toThrow();
    expect(() => requireControlPlaneDatabase('test')).not.toThrow();
  });

  it('requires storage deployment to match a production or sandbox database', () => {
    expect(() => requireStorageDeployment('test', 'test')).toThrow(
      'object storage scope test is incompatible with database deployment test',
    );
    expect(() => requireStorageDeployment('test', 'production')).toThrow(
      'incompatible with database deployment test',
    );
    expect(() => requireStorageDeployment('test', 'sandbox')).toThrow(
      'incompatible with database deployment test',
    );
    expect(() => requireStorageDeployment('production', 'sandbox')).toThrow(
      'incompatible with database deployment production',
    );
    expect(() =>
      requireStorageDeployment('production', 'production'),
    ).not.toThrow();
    expect(() => requireStorageDeployment('sandbox', 'sandbox')).not.toThrow();
  });

  it('uses the earlier clock for age-based deletion', () => {
    const processNow = new Date('2026-12-01T00:00:00.000Z');
    const databaseNow = new Date('2026-11-01T00:00:00.000Z');

    expect(effectiveMaintenanceTime(processNow, databaseNow)).toEqual({
      now: databaseNow,
      source: 'database',
    });
  });

  it('previews command intent without exposing credential values', () => {
    expect(
      previewOperatorMutation(
        'key:create',
        new Map([
          ['org', 'org_123'],
          ['name', 'preview key'],
          ['actor', 'ops-alice'],
          ['scopes', 'writing.grade'],
        ]),
      ),
    ).toEqual({
      command: 'key:create',
      action: 'create an API key',
      inputs: {
        org: 'org_123',
        name: 'preview key',
        scopes: 'writing.grade',
        actor: 'ops-alice',
      },
      target: 'org_123',
    });
    expect(
      previewOperatorMutation(
        'billing:adjust',
        new Map([
          ['id', 'badj_123'],
          ['org', 'org_123'],
          ['month', '2026-10'],
          ['operation', 'writing.grade'],
          ['requests', '-12'],
          ['period-from', '2026-10-01T00:00:00.000Z'],
          ['period-to', '2026-11-01T00:00:00.000Z'],
          ['actor', 'ops-alice'],
          ['reason', 'customer correction'],
        ]),
      ),
    ).toEqual({
      command: 'billing:adjust',
      action: 'record a billing adjustment',
      inputs: {
        id: 'badj_123',
        org: 'org_123',
        month: '2026-10',
        operation: 'writing.grade',
        requests: '-12',
        'period-from': '2026-10-01T00:00:00.000Z',
        'period-to': '2026-11-01T00:00:00.000Z',
        actor: 'ops-alice',
        reason_supplied: 'true',
      },
      target: 'badj_123',
    });
    expect(
      previewOperatorMutation(
        'key:create',
        new Map([
          ['org', 'org_123'],
          ['name', 'preview key'],
          ['scopes', 'writing.grade'],
          ['envs', 'sandbox'],
          ['internal', 'false'],
          ['actor', 'ops-alice'],
        ]),
      ).inputs,
    ).toEqual({
      org: 'org_123',
      name: 'preview key',
      scopes: 'writing.grade',
      envs: 'sandbox',
      internal: 'false',
      actor: 'ops-alice',
    });
    expect(
      previewOperatorMutation(
        'writing:chart-revoke',
        new Map([
          [
            'url',
            'https://operator:secret@s3.wispace.app/chart.png?token=secret#fragment',
          ],
        ]),
      ),
    ).toEqual({
      command: 'writing:chart-revoke',
      action: 'revoke a published writing chart',
      inputs: { url: 'https://s3.wispace.app/chart.png' },
      target: 'https://s3.wispace.app/chart.png',
    });
    expect(
      previewOperatorMutation(
        'org:create',
        new Map([
          ['name', 'New org'],
          ['entitlements', 'writing,speaking'],
          ['rate-limit-rpm', '600'],
          ['monthly-quota', '10000'],
          ['hard-stop', 'true'],
        ]),
      ).inputs,
    ).toEqual({
      name: 'New org',
      entitlements: 'writing,speaking',
      'rate-limit-rpm': '600',
      'monthly-quota': '10000',
      'hard-stop': 'true',
    });
    expect(
      previewOperatorMutation(
        'identity:set',
        new Map([
          ['org', 'org_123'],
          ['issuer', 'https://issuer.example/path?token=secret'],
          ['public-keys-file', 'C:\\private\\jwks.json'],
          ['status', 'active'],
        ]),
      ).inputs,
    ).toEqual({
      org: 'org_123',
      issuer: 'https://issuer.example/path',
      status: 'active',
      'key-source': 'inline',
    });
    expect(
      previewOperatorMutation(
        'billing:adjust',
        new Map([
          ['id', 'badj_123'],
          ['org', 'org_123'],
          ['month', '2026-10'],
          ['operation', 'writing.grade'],
          ['requests', '12'],
          ['request-ids', 'req_a,req_b'],
        ]),
      ).inputs['request-ids'],
    ).toBe('req_a,req_b');
    expect(() => previewOperatorMutation('key:create', new Map())).toThrow(
      'operator preview requires --org',
    );
  });

  it('keeps the complete current mutation inventory at the safety boundary', () => {
    expect([...MUTATING_COMMANDS].sort()).toEqual(
      [
        'avatar:sweep',
        'billing:adjust',
        'billing:statement',
        'idempotency:cleanup',
        'identity:set',
        'key:create',
        'key:revoke',
        'notifications:sweep',
        'org:attach-owner',
        'org:create',
        'org:grant-entitlement',
        'org:restore',
        'org:suspend',
        'quota:reconcile',
        'registrations:sweep',
        'session:revoke-all-refresh',
        'speaking:audio-upload-sweep',
        'usage:prune',
        'user:disable',
        'user:restore',
        'writing:chart-revoke',
        'writing:chart-upload-sweep',
      ].sort(),
    );
    expect(
      isMutatingCommand('billing:statement', new Map([['close', 'false']])),
    ).toBe(false);
    expect(
      isMutatingCommand('billing:statement', new Map([['close', 'TRUE']])),
    ).toBe(true);
    expect([...CONTROL_PLANE_COMMANDS]).toContain('key:revoke');
  });
});
