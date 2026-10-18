import { selfServeOrganizationTerms } from './create-organization';

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
