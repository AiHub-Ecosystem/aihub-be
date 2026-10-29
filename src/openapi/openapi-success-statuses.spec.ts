import type { TSchema } from '@sinclair/typebox';

import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import type { PublicRouteDef } from '@/catalog/public-routes';
import { buildOpenApiDocument } from './build-openapi-document';
import { toOpenApiPath } from './openapi-path';
import { extendPublicResponseSchemas } from './openapi-response-schemas';

interface PublishedResponse {
  readonly headers?: Record<string, unknown>;
  readonly content?: Record<string, { readonly schema: unknown }>;
}

interface PublishedOperation {
  readonly responses: Record<string, PublishedResponse>;
}

type PublishedPaths = Record<
  string,
  Record<string, PublishedOperation | undefined> | undefined
>;

const ROUTES = Object.entries(PUBLIC_ROUTES) as [string, PublicRouteDef][];

function publishedOperation(route: PublicRouteDef): PublishedOperation {
  const { paths } = buildOpenApiDocument('0.0.0-test') as {
    paths: PublishedPaths;
  };
  const operation =
    paths[toOpenApiPath(route.path)]?.[route.method.toLowerCase()];
  if (operation === undefined) {
    throw new Error(`${route.method} ${route.path} is not published`);
  }
  return operation;
}

/** A response schema as the document publishes it: open to added members. */
function publishedFormOf(schema: TSchema | null): unknown {
  if (schema === null) return undefined;
  const response = { content: { 'application/json': { schema } } };
  extendPublicResponseSchemas({
    paths: { '/': { post: { responses: { '200': response } } } },
    components: { responses: {} },
  });
  return response.content['application/json'].schema;
}

function cacheControlHeaderNames(route: PublicRouteDef): string[] {
  return route.cacheControl === undefined ? [] : ['Cache-Control'];
}

describe('conditional success statuses', () => {
  it.each(ROUTES)(
    '%s publishes exactly its declared success statuses',
    (_routeId, route) => {
      const published = Object.keys(publishedOperation(route).responses)
        .filter((status) => status.startsWith('2'))
        .sort();
      const declared = [
        route.successStatus,
        ...(route.alternateSuccesses ?? []).map(({ status }) => status),
      ]
        .map(String)
        .sort();

      expect(published).toEqual(declared);
    },
  );

  const ALTERNATES = ROUTES.flatMap(([routeId, route]) =>
    (route.alternateSuccesses ?? []).map(
      (alternate) => [routeId, alternate.status, route, alternate] as const,
    ),
  );

  it('covers every runtime alternate the controllers answer', () => {
    expect(
      ALTERNATES.map(([routeId, status]) => `${routeId} ${status}`).sort(),
    ).toEqual([
      'auth.login 202',
      'auth.verify_email 204',
      'auth.web_sessions.create 202',
      'auth.web_sessions.verification 204',
      'me.avatar.uploads.complete 200',
      'speaking.audioUploads.complete 200',
    ]);
  });

  it.each(ALTERNATES)(
    '%s %s publishes its declared body and only the route Cache-Control header',
    (_routeId, status, route, alternate) => {
      const response = publishedOperation(route).responses[String(status)];

      expect(response?.content?.['application/json']?.schema).toEqual(
        publishedFormOf(alternate.responseSchema),
      );
      expect(Object.keys(response?.headers ?? {})).toEqual(
        cacheControlHeaderNames(route),
      );
    },
  );
});
