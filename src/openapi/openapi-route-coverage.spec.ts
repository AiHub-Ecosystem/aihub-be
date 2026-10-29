import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { PublicRouteDef } from '@/catalog/public-routes';
import { buildOpenApiDocument } from './build-openapi-document';
import { toOpenApiPath } from './openapi-path';

interface PublishedOperation {
  readonly operationId: string;
  readonly summary: string;
}

type PublishedPaths = Record<
  string,
  Record<string, PublishedOperation | undefined> | undefined
>;

const ROUTES = Object.entries(PUBLIC_ROUTES) as [string, PublicRouteDef][];
const { paths } = buildOpenApiDocument() as {
  paths: PublishedPaths;
};

function publishedOperation(
  route: PublicRouteDef,
): PublishedOperation | undefined {
  return paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()];
}

describe('public route coverage', () => {
  it.each(ROUTES.filter(([, route]) => route.openApi !== undefined))(
    '%s is published from its openApi metadata',
    (routeId, route) => {
      expect(publishedOperation(route)).toMatchObject({
        operationId: routeId,
        summary: route.openApi?.summary,
      });
    },
  );

  // A route without metadata needs a hand-built path item; one that has
  // neither would be served but missing from the document.
  it.each(ROUTES.filter(([, route]) => route.openApi === undefined))(
    '%s is published by a hand-built path item',
    (routeId, route) => {
      expect(publishedOperation(route)?.operationId).toBe(routeId);
    },
  );
});
