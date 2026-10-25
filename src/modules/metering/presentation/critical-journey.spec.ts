import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { criticalJourneyForRequest } from './critical-journey';

describe('criticalJourneyForRequest', () => {
  it('identifies graded, authentication, organization, and API-key journeys', () => {
    const grade = OPERATION_CATALOG['writing.task1.grade'];
    const login = PUBLIC_ROUTES['auth.login'];
    const organization = PUBLIC_ROUTES['organizations.create'];
    const apiKey = PUBLIC_ROUTES['organizations.apiKeys.create'];

    expect(
      criticalJourneyForRequest(
        grade.method,
        grade.path,
        'writing.task1.grade',
      ),
    ).toBe('graded_request');
    expect(criticalJourneyForRequest(login.method, login.path, undefined)).toBe(
      'authentication',
    );
    expect(
      criticalJourneyForRequest(
        organization.method,
        organization.path,
        undefined,
      ),
    ).toBe('organization_management');
    expect(
      criticalJourneyForRequest(apiKey.method, apiKey.path, undefined),
    ).toBe('api_key_management');
  });

  it('leaves unmatched routes outside the declared SLO journeys', () => {
    expect(criticalJourneyForRequest('GET', '/not-a-route', undefined)).toBe(
      undefined,
    );
  });
});
