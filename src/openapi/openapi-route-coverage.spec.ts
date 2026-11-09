import { publicApiMajorV1 } from '@/catalog/public-api-major-v1.fixture';
import { findPublicApiMajor } from '@/catalog/public-api-majors';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';
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
/** Each route is published in the document of the major its path names. */
const PATHS_BY_MAJOR = {
  v1: (buildOpenApiDocument(publicApiMajorV1()) as { paths: PublishedPaths })
    .paths,
  v2: (buildOpenApiDocument(findPublicApiMajor(2)) as { paths: PublishedPaths })
    .paths,
};

function pathsFor(route: PublicRouteDef): PublishedPaths {
  return route.path.startsWith('/v2/') ? PATHS_BY_MAJOR.v2 : PATHS_BY_MAJOR.v1;
}

function publishedOperation(
  route: PublicRouteDef,
): PublishedOperation | undefined {
  return pathsFor(route)[toOpenApiPath(route.path)]?.[
    route.method.toLowerCase()
  ];
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
