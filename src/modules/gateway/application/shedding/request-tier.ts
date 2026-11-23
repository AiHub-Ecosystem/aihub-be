import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { compilePathTemplate } from '@/catalog/path-template';
import { PUBLIC_ROUTES, type PublicRouteId } from '@/catalog/public-routes';
import { PUBLIC_ROUTE_TIERS, type RequestTier } from '@/catalog/request-tiers';
import { isHealthProbe, pathnameOf } from '@/common/http/request-path';
import { METRICS_ROUTE_PATH } from '@/common/observability/metrics/metrics';

export type { RequestTier };

interface TieredRoute {
  readonly method: string;
  readonly path: string;
  readonly tier: RequestTier;
}

/**
 * Built once: every catalog operation dispatches to an AI Service, so every one
 * of them is `best-effort`. The non-dispatch registry decides the rest.
 */
const TIERED_ROUTES: readonly TieredRoute[] = Object.freeze([
  ...Object.values(OPERATION_CATALOG).map((operation) =>
    Object.freeze({
      method: operation.method,
      path: operation.path,
      tier: 'best-effort' as const,
    }),
  ),
  ...(Object.keys(PUBLIC_ROUTES) as readonly PublicRouteId[]).map((routeId) =>
    Object.freeze({
      method: PUBLIC_ROUTES[routeId].method,
      path: PUBLIC_ROUTES[routeId].path,
      tier: PUBLIC_ROUTE_TIERS[routeId],
    }),
  ),
]);

const EXACT_TIERS: ReadonlyMap<string, RequestTier> = new Map(
  TIERED_ROUTES.filter((route) => !/[{}:]/.test(route.path)).map((route) => [
    `${route.method} ${route.path}`,
    route.tier,
  ]),
);

const TEMPLATED_TIERS: readonly {
  readonly method: string;
  readonly pattern: RegExp;
  readonly tier: RequestTier;
}[] = TIERED_ROUTES.filter((route) => /[{}:]/.test(route.path)).map(
  (route) => ({
    method: route.method,
    pattern: compilePathTemplate(route.path),
    tier: route.tier,
  }),
);

/**
 * The tier of a request, from its method and path alone.
 *
 * Both are known before any header or byte of the body is read, which is what
 * lets the refusal land in `onRequest` and cost a table lookup. An unknown
 * path keeps its `404`: it dispatches nothing, so refusing it protects nothing
 * and would turn a caller's typo into an outage signal.
 */
export function requestTierOf(method: string, url: string): RequestTier {
  const path = pathnameOf(url);
  // A refused probe or scrape tells the balancer and Prometheus the whole
  // instance is dead, which is worse than the capacity it saves.
  if (isHealthProbe(url) || path === METRICS_ROUTE_PATH) return 'critical';

  // Fastify answers a `HEAD` from the registered `GET` handler, so a `HEAD`
  // costs exactly the work the equivalent `GET` does and takes its tier.
  const routeMethod = method === 'HEAD' ? 'GET' : method;

  const exact = EXACT_TIERS.get(`${routeMethod} ${path}`);
  if (exact !== undefined) return exact;

  return (
    TEMPLATED_TIERS.find(
      (candidate) =>
        candidate.method === routeMethod && candidate.pattern.test(path),
    )?.tier ?? 'critical'
  );
}

/**
 * The tiers refused at each level, lowest first: level 1 sheds `best-effort`,
 * level 2 adds `standard`. `critical` is never in the list: a caller refused at
 * authentication or billing cannot even learn to slow down, and the dispatch
 * that saturates the host is what shedding is for.
 */
const SHED_TIERS_BY_LEVEL: readonly (readonly RequestTier[])[] = [
  [],
  ['best-effort'],
  ['best-effort', 'standard'],
];

/** Whether a tier is refused at a shedding level. */
export function shedsAtLevel(tier: RequestTier, level: number): boolean {
  return (
    SHED_TIERS_BY_LEVEL[clampSheddingLevel(level)]?.includes(tier) ?? false
  );
}

/** A level clamped to the table above, for a value read from Redis or a peer. */
export function clampSheddingLevel(value: number): number {
  return Number.isFinite(value)
    ? Math.max(0, Math.min(SHED_TIERS_BY_LEVEL.length - 1, Math.floor(value)))
    : 0;
}
