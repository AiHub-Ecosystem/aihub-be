import {
  apiKeyDisplayPrefix,
  isApiKeyFormat,
} from '@/modules/identity/domain/api-key';
import {
  generateApiKey,
  generateOrganizationApiKey,
  hashApiKey,
} from './organization-api-key-generator';

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

describe.each([
  ['operator', () => generateApiKey('key-1', 'production')],
  ['Organization', () => generateOrganizationApiKey(new Date(), 'production')],
])('the %s key family encodes one secret format', (_family, generate) => {
  it('mints a 43-character base62 secret behind the environment prefix', () => {
    for (let index = 0; index < 50; index += 1) {
      const key = generate();

      expect(isApiKeyFormat(key.raw)).toBe(true);
      expect(key.raw).toMatch(/^aihub_prod_[A-Za-z0-9]{43}$/);
      expect(key.hash).toBe(hashApiKey(key.raw));
      expect(key.prefix).toBe(apiKeyDisplayPrefix(key.raw));
    }
  });
});
