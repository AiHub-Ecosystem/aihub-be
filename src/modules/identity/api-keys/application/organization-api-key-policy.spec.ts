import {
  hasRequiredOrganizationApiKeyEntitlements,
  reachedOrganizationApiKeyLimit,
} from './organization-api-key-policy';

describe('Organization API key policy', () => {
  it('requires every requested entitlement from the locked Organization row', () => {
    expect(
      hasRequiredOrganizationApiKeyEntitlements(
        ['writing', 'speaking'],
        ['writing'],
      ),
    ).toBe(true);
    expect(
      hasRequiredOrganizationApiKeyEntitlements(
        ['writing'],
        ['writing', 'speaking'],
      ),
    ).toBe(false);
  });

  it('allows no required entitlements', () => {
    expect(hasRequiredOrganizationApiKeyEntitlements([], [])).toBe(true);
  });

  it('reaches the active-key cap at equality and beyond', () => {
    expect(reachedOrganizationApiKeyLimit(9, 10)).toBe(false);
    expect(reachedOrganizationApiKeyLimit(10, 10)).toBe(true);
    expect(reachedOrganizationApiKeyLimit(11, 10)).toBe(true);
  });
});
