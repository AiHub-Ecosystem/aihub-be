import type { FastifyInstance } from 'fastify';

import {
  OPERATION_CATALOG,
  type OperationDef,
} from '@/catalog/operation-catalog';
import { publicApiMajorOf } from '@/catalog/public-api-major';
import {
  PUBLIC_API_MAJORS,
  type PublicApiMajorDef,
  findPublicApiMajor,
} from '@/catalog/public-api-majors';
import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';

const BASELINE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DEPRECATED_ROUTES = Object.values(PUBLIC_ROUTES).filter(
  (route) => (route as PublicRouteDef).sunset !== undefined,
) as PublicRouteDef[];

type DeprecatedRoute = Pick<PublicRouteDef, 'method' | 'path' | 'sunset'>;

const NO_STORE_ROUTES = new Set([
  ...(Object.values(PUBLIC_ROUTES) as PublicRouteDef[])
    .filter((route) => route.cacheControl?.value === 'no-store')
    .map((route) => `${route.method} ${route.path}`),
  ...(Object.values(OPERATION_CATALOG) as OperationDef[])
    .filter((operation) => operation.cacheControl?.value === 'no-store')
    .map((operation) => `${operation.method} ${operation.path}`),
]);

function matchDeprecatedRoute(
  method: string,
  url: string,
  deprecatedRoutes: readonly DeprecatedRoute[],
): DeprecatedRoute | undefined {
  const path = url.split('?')[0] ?? url;
  return deprecatedRoutes.find((route) => {
    if (route.method !== method) return false;
    const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`);
    return pattern.test(path);
  });
}

function formatHttpDate(date: string): string {
  return new Date(date).toUTCString();
}

interface SunsetNotice {
  readonly deprecationAt: string;
  readonly sunsetAt: string;
  readonly link?: string;
}

function routeNotice(
  route: DeprecatedRoute | undefined,
): SunsetNotice | undefined {
  const sunset = route?.sunset;
  if (sunset === undefined) return undefined;
  return {
    deprecationAt: sunset.deprecationAt,
    sunsetAt: sunset.sunsetAt,
    ...(sunset.successorRouteId === undefined
      ? {}
      : {
          link: `</docs#${sunset.successorRouteId}>; rel="successor-version"; title="${sunset.successorRouteId}"`,
        }),
  };
}

/** A major's sunset covers every route under it, dispatch routes included. */
function majorNotice(
  routeTemplate: string | undefined,
  majors: readonly PublicApiMajorDef[],
): SunsetNotice | undefined {
  const major =
    routeTemplate === undefined ? undefined : publicApiMajorOf(routeTemplate);
  const sunset =
    major === undefined ? undefined : findPublicApiMajor(major, majors)?.sunset;
  if (sunset === undefined) return undefined;
  const successor = `v${sunset.successor}`;
  return {
    deprecationAt: sunset.deprecationAt,
    sunsetAt: sunset.sunsetAt,
    link: `</docs?version=${successor}>; rel="successor-version"; title="${successor}"`,
  };
}

/** Both dates are the earlier of the two; the link follows the earlier sunset. */
function earlierNotice(
  route: SunsetNotice | undefined,
  major: SunsetNotice | undefined,
): SunsetNotice | undefined {
  if (route === undefined || major === undefined) return route ?? major;
  const first =
    Date.parse(major.sunsetAt) < Date.parse(route.sunsetAt) ? major : route;
  return {
    ...first,
    deprecationAt:
      Date.parse(major.deprecationAt) < Date.parse(route.deprecationAt)
        ? major.deprecationAt
        : route.deprecationAt,
  };
}

export function registerSecurityHeaders(
  instance: FastifyInstance,
  deprecatedRoutes: readonly DeprecatedRoute[] = DEPRECATED_ROUTES,
  majors: readonly PublicApiMajorDef[] = PUBLIC_API_MAJORS,
): void {
  instance.addHook('onSend', (request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', BASELINE_CONTENT_SECURITY_POLICY);
    }
    if (!reply.hasHeader('x-frame-options')) {
      reply.header('X-Frame-Options', 'DENY');
    }

    const routeMethod = request.method === 'HEAD' ? 'GET' : request.method;
    if (NO_STORE_ROUTES.has(`${routeMethod} ${request.routeOptions.url}`)) {
      reply.header('Cache-Control', 'no-store');
    }

    const notice = earlierNotice(
      routeNotice(
        matchDeprecatedRoute(request.method, request.url, deprecatedRoutes),
      ),
      majorNotice(request.routeOptions.url, majors),
    );
    if (notice !== undefined) {
      if (!reply.hasHeader('deprecation')) {
        const deprecationTimestamp = Math.floor(
          Date.parse(notice.deprecationAt) / 1000,
        );
        reply.header('Deprecation', `@${deprecationTimestamp}`);
      }
      if (!reply.hasHeader('sunset')) {
        reply.header('Sunset', formatHttpDate(notice.sunsetAt));
      }
      if (notice.link !== undefined && !reply.hasHeader('link')) {
        reply.header('Link', notice.link);
      }
    }

    done(null, payload);
  });
}

export { BASELINE_CONTENT_SECURITY_POLICY };
