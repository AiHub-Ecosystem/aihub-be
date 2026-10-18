import type { FastifyInstance } from 'fastify';

import { PUBLIC_ROUTES, type PublicRouteDef } from '@/catalog/public-routes';

const BASELINE_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DEPRECATED_ROUTES = Object.values(PUBLIC_ROUTES).filter(
  (route) => (route as PublicRouteDef).sunset !== undefined,
) as PublicRouteDef[];

function matchDeprecatedRoute(
  method: string,
  url: string,
): (typeof DEPRECATED_ROUTES)[number] | undefined {
  const path = url.split('?')[0] ?? url;
  return DEPRECATED_ROUTES.find((route) => {
    if (route.method !== method) return false;
    const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`);
    return pattern.test(path);
  });
}

function formatHttpDate(date: string): string {
  return new Date(date).toUTCString();
}

export function registerSecurityHeaders(instance: FastifyInstance): void {
  instance.addHook('onSend', (request, reply, payload, done) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', BASELINE_CONTENT_SECURITY_POLICY);
    }
    if (!reply.hasHeader('x-frame-options')) {
      reply.header('X-Frame-Options', 'DENY');
    }

    const route = matchDeprecatedRoute(request.method, request.url) as
      | PublicRouteDef
      | undefined;
    if (route?.sunset !== undefined) {
      if (!reply.hasHeader('deprecation')) {
        reply.header('Deprecation', `@${route.sunset.sunsetAt}`);
      }
      if (!reply.hasHeader('sunset')) {
        reply.header('Sunset', formatHttpDate(route.sunset.sunsetAt));
      }
      if (
        route.sunset.successorRouteId !== undefined &&
        !reply.hasHeader('link')
      ) {
        reply.header(
          'Link',
          `</docs#${route.sunset.successorRouteId}>; rel="successor-version"; title="${route.sunset.successorRouteId}"`,
        );
      }
    }

    done(null, payload);
  });
}

export { BASELINE_CONTENT_SECURITY_POLICY };
