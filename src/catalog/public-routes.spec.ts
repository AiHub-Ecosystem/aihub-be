import { OPERATION_CATALOG } from './operation-catalog';
import { PUBLIC_ROUTES } from './public-routes';

/**
 * The segment that names an Organization. Other `:camelCaseId` segments, such
 * as an Avatar's `:assetId`, name something else and say nothing about where
 * the route learns its Organization.
 */
function organizationSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment === ':organizationId');
}

describe('PUBLIC_ROUTES', () => {
  /**
   * `organizationResolution` is a declaration, not a comment: nothing in the
   * runtime reads it. Without this, a route could claim to take its
   * Organization from the path while carrying no organization segment, and a
   * generator that trusted it would publish a parameter the route rejects.
   */
  it('declares an Organization segment exactly when the route says it learns one from the path', () => {
    const mismatches: Record<string, string> = {};

    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      const declaresPath = route.organizationResolution === 'path';
      if (declaresPath !== organizationSegments(route.path).length > 0) {
        mismatches[routeId] =
          `${route.organizationResolution} on ${route.path}`;
      }
    }

    expect(mismatches).toEqual({});
  });

  it('never reuses a dispatch operation path', () => {
    const dispatchPaths = new Set<string>(
      Object.values(OPERATION_CATALOG).map((operation) => operation.path),
    );

    const collisions: Record<string, string> = {};
    for (const [routeId, route] of Object.entries(PUBLIC_ROUTES)) {
      if (dispatchPaths.has(route.path)) {
        collisions[routeId] = route.path;
      }
    }

    expect(collisions).toEqual({});
  });
});
