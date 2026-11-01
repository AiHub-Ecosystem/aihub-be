import {
  WRITING_V3_ORGANIZATION_NAMESPACE,
  providerOrganizationId,
  uuidV5,
} from './writing-v3-organization-id';

const RFC_DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5', () => {
  it('matches the RFC 4122 name-based vector for python.org in the DNS namespace', () => {
    expect(uuidV5('python.org', RFC_DNS_NAMESPACE)).toBe(
      '886313e1-3b8a-5372-9b90-0c9aee199e5d',
    );
  });
});

describe('providerOrganizationId', () => {
  it('is pinned: changing the namespace re-partitions every learner history (ADR-0143)', () => {
    expect(WRITING_V3_ORGANIZATION_NAMESPACE).toBe(
      '70a63f65-823c-4ae7-8443-58c2f643a746',
    );
    expect(providerOrganizationId('org_acme')).toBe(
      '29697b4c-0f71-58ee-888b-066afe6d1da9',
    );
  });

  it('is a valid 36-character UUID the provider accepts', () => {
    expect(providerOrganizationId('org_01J8QK3M7XW2P5NRTVA9BCDEFG')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is deterministic and case-sensitive like the Organization ID', () => {
    expect(providerOrganizationId('org_a')).toBe(
      providerOrganizationId('org_a'),
    );
    expect(providerOrganizationId('org_a')).not.toBe(
      providerOrganizationId('org_A'),
    );
  });
});
