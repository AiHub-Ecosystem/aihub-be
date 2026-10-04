import { apiKeyRecordFromRow } from './postgres-api-key.repository';

const row = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  organizationStatus: 'active',
  status: 'active',
  scopes: ['writing.grade'],
  entitlements: ['writing'],
  allowedEnvironments: ['development', 'production'],
  expiresAt: null,
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

describe('apiKeyRecordFromRow', () => {
  it('maps a looked-up key to its Organization and policy', () => {
    expect(apiKeyRecordFromRow(row)).toEqual({
      organizationId: 'org_acme',
      apiKeyId: 'ak_backend',
      organizationStatus: 'active',
      status: 'active',
      scopes: ['writing.grade'],
      entitlements: ['writing'],
      allowedEnvironments: ['development', 'production'],
      expiresAt: null,
      rateLimitRpm: 600,
      maxConcurrent: 20,
      monthlyRequestQuota: null,
      hardStopOnQuota: false,
    });
  });

  it('keeps a revoked key and a suspended Organization distinguishable', () => {
    expect(
      apiKeyRecordFromRow({
        ...row,
        status: 'revoked',
        organizationStatus: 'suspended',
      }),
    ).toMatchObject({ status: 'revoked', organizationStatus: 'suspended' });
  });

  it('carries an expiry and a granted quota through unchanged', () => {
    const expiresAt = new Date('2026-09-22T12:34:56.000Z');

    expect(
      apiKeyRecordFromRow({ ...row, expiresAt, monthlyRequestQuota: 0 }),
    ).toMatchObject({ expiresAt, monthlyRequestQuota: 0 });
  });

  it.each([
    ['a scope that is not a string', { scopes: ['writing.grade', 7] }],
    ['a status outside its vocabulary', { status: 'pending' }],
    ['a limit that is not a positive integer', { rateLimitRpm: 0 }],
    ['a negative quota', { monthlyRequestQuota: -1 }],
    ['a hard-stop flag that is not a boolean', { hardStopOnQuota: 'yes' }],
    ['an expiry that is not a date', { expiresAt: 'soon' }],
    ['a missing Organization', { organizationId: '' }],
  ])('refuses %s', (_reason, override) => {
    expect(apiKeyRecordFromRow({ ...row, ...override })).toBeUndefined();
  });

  it('refuses a row that is not an object', () => {
    expect(apiKeyRecordFromRow(null)).toBeUndefined();
    expect(apiKeyRecordFromRow([row])).toBeUndefined();
  });
});
