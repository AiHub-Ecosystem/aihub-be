import {
  DEFAULT_MONTHLY_REQUEST_QUOTA,
  SelfServeTermsConfigurationError,
  selfServeMonthlyRequestQuota,
  selfServeOrganizationTerms,
} from './create-organization';

describe('selfServeMonthlyRequestQuota', () => {
  it('falls back to the built-in default when unset', () => {
    expect(selfServeMonthlyRequestQuota(undefined)).toBe(
      DEFAULT_MONTHLY_REQUEST_QUOTA,
    );
    expect(selfServeMonthlyRequestQuota('')).toBe(
      DEFAULT_MONTHLY_REQUEST_QUOTA,
    );
    expect(selfServeMonthlyRequestQuota('   ')).toBe(
      DEFAULT_MONTHLY_REQUEST_QUOTA,
    );
  });

  it('reads the configured value', () => {
    expect(selfServeMonthlyRequestQuota('100')).toBe(100);
    expect(selfServeMonthlyRequestQuota(' 250 ')).toBe(250);
    expect(selfServeMonthlyRequestQuota('1000000')).toBe(1_000_000);
    expect(selfServeMonthlyRequestQuota('1')).toBe(1);
  });

  it.each([
    'abc',
    '-1',
    '1.5',
    '1e3',
    '1 000',
    '+100',
    '100abc',
    '0',
    '00',
    '007',
    '-0',
  ])('refuses the invalid value %p', (value) => {
    expect(() => selfServeMonthlyRequestQuota(value)).toThrow(
      SelfServeTermsConfigurationError,
    );
  });

  it('refuses a value beyond exact integer range', () => {
    expect(() => selfServeMonthlyRequestQuota('99999999999999999999')).toThrow(
      SelfServeTermsConfigurationError,
    );
  });
});

describe('selfServeOrganizationTerms', () => {
  it('carries the quota with the other default terms', () => {
    expect(selfServeOrganizationTerms(1_000_000)).toEqual({
      entitlements: ['writing', 'speaking'],
      rateLimitRpm: 60,
      maxConcurrent: 5,
      monthlyRequestQuota: 1_000_000,
      hardStopOnQuota: true,
    });
  });
});
