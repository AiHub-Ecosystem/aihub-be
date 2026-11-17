import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import { requestTierOf, shedsAtLevel } from './request-tier';

describe('requestTierOf', () => {
  it('ranks every dispatch operation best-effort', () => {
    for (const operation of Object.values(OPERATION_CATALOG)) {
      expect(requestTierOf(operation.method, operation.path)).toBe(
        'best-effort',
      );
    }
  });

  it('keeps authentication and organization control-plane routes critical', () => {
    expect(requestTierOf('POST', '/v1/auth/login')).toBe('critical');
    expect(requestTierOf('POST', '/v1/auth/refresh')).toBe('critical');
    expect(requestTierOf('POST', '/v1/sandbox/assertions')).toBe('critical');
  });

  it('ranks the rest of the public routes standard', () => {
    expect(requestTierOf('GET', '/v1/ielts/speaking/questions')).toBe(
      'standard',
    );
    expect(requestTierOf('POST', '/v1/me/avatar/uploads')).toBe('standard');
  });

  it('matches path parameters, not a prefix of them', () => {
    expect(
      requestTierOf('GET', '/v1/organizations/org_123/members?limit=10'),
    ).toBe('critical');
    expect(
      requestTierOf('GET', '/v1/organizations/org_123/members/extra'),
    ).toBe('critical');
  });

  it('treats an unknown path as critical so its 404 still reaches the caller', () => {
    expect(requestTierOf('GET', '/v1/not-a-route')).toBe('critical');
  });

  it('never sheds infrastructure paths', () => {
    expect(requestTierOf('GET', '/health')).toBe('critical');
    expect(requestTierOf('GET', '/metrics')).toBe('critical');
  });

  it('covers every public route exactly once', () => {
    for (const route of Object.values(PUBLIC_ROUTES)) {
      expect(requestTierOf(route.method, route.path)).not.toBeUndefined();
    }
  });
});

describe('shedsAtLevel', () => {
  it('sheds from the lowest tier upward and never critical', () => {
    expect(shedsAtLevel('best-effort', 0)).toBe(false);
    expect(shedsAtLevel('best-effort', 1)).toBe(true);
    expect(shedsAtLevel('standard', 1)).toBe(false);
    expect(shedsAtLevel('standard', 2)).toBe(true);
    expect(shedsAtLevel('critical', 2)).toBe(false);
  });
});
