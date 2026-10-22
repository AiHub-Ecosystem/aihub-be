import { planApiKeyNearExpiryNotices } from './plan-api-key-near-expiry-notices';

describe('planApiKeyNearExpiryNotices', () => {
  it('gives each recipient one notice listing every newly recorded key of their Organization', () => {
    const notices = planApiKeyNearExpiryNotices(
      [
        { organizationId: 'org_a', apiKeyId: 'key_2' },
        { organizationId: 'org_b', apiKeyId: 'key_3' },
        { organizationId: 'org_a', apiKeyId: 'key_1' },
      ],
      [
        { organizationId: 'org_a', userAccountId: 'usr_owner' },
        { organizationId: 'org_a', userAccountId: 'usr_admin' },
        { organizationId: 'org_b', userAccountId: 'usr_other' },
      ],
    );

    expect(notices).toEqual([
      {
        organizationId: 'org_a',
        userAccountId: 'usr_owner',
        apiKeyIds: ['key_1', 'key_2'],
      },
      {
        organizationId: 'org_a',
        userAccountId: 'usr_admin',
        apiKeyIds: ['key_1', 'key_2'],
      },
      {
        organizationId: 'org_b',
        userAccountId: 'usr_other',
        apiKeyIds: ['key_3'],
      },
    ]);
  });

  it('plans nothing for a recipient whose Organization recorded no key', () => {
    expect(
      planApiKeyNearExpiryNotices(
        [],
        [{ organizationId: 'org_a', userAccountId: 'usr_owner' }],
      ),
    ).toEqual([]);
  });
});
