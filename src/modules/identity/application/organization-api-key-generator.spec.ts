import { generateOrganizationApiKey } from './organization-api-key-generator';

describe('generateOrganizationApiKey', () => {
  it('orders API key IDs by mint order when timestamps match', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const ids = Array.from(
      { length: 20 },
      () => generateOrganizationApiKey(now).id,
    );

    expect([...ids].sort()).toEqual(ids);
  });
});
