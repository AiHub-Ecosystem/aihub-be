import type { AuthenticatedApiKey } from './api-key-authenticator.port';
import { hasRequiredScope } from './authorization';

const apiKey: AuthenticatedApiKey = {
  organizationId: 'org_acme',
  apiKeyId: 'ak_backend',
  environment: 'production',
  scopes: ['writing.grade'],
  rateLimitRpm: 600,
  maxConcurrent: 20,
  monthlyRequestQuota: null,
  hardStopOnQuota: false,
};

describe('hasRequiredScope', () => {
  it('allows an effective scope that is present on the authenticated key', () => {
    expect(hasRequiredScope(apiKey, 'writing.grade')).toBe(true);
  });

  it('denies a scope that is absent from the authenticated key', () => {
    expect(hasRequiredScope(apiKey, 'speaking.grade')).toBe(false);
  });
});
