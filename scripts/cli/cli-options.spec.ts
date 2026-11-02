import {
  CliUsageError,
  booleanOption,
  environmentOption,
  quotaOption,
} from './cli-options.cjs';
import {
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
        'speaking:audio-upload-sweep',
        'usage:prune',
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
