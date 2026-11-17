import { OPERATION_CATALOG } from '@/catalog/operation-catalog';
import { PUBLIC_ROUTES, type PublicRouteId } from '@/catalog/public-routes';
import { pathnameOf } from '@/common/http/request-path';

/**
 * How the gateway ranks a request when it must shed load (#1591).
 *
 * - `critical`: refusing it cannot save the capacity that is short. Only routes
 *   that merely authenticate, bill, or mint credentials live here.
 * - `standard`: authenticated control-plane work.
 * - `best-effort`: the dispatch that leaves the process. Shed first.
 */
export type RequestTier = 'critical' | 'standard' | 'best-effort';

/**
 * Routes that keep answering while load is shed. Each one spends almost no
 * downstream capacity, and a caller refused here has no way left to slow down.
 */
const CRITICAL_ROUTE_IDS: ReadonlySet<PublicRouteId> = new Set<PublicRouteId>([
  'auth.register',
  'auth.login',
  'auth.refresh',
  'auth.logout',
  'auth.mfa.enrollment',
  'auth.mfa.enrollment.confirm',
  'auth.mfa.remove',
  'auth.verify_email',
  'auth.resend_verification',
  'auth.forgot_password',
  'auth.reset_password',
  'auth.change_password',
  'auth.user_access_tokens.revoke',
  'auth.web_sessions.create',
  'auth.web_sessions.verification',
  'auth.web_sessions.exchange',
  'auth.web_sessions.logout',
  'sandbox.assertions.mint',
  'sandbox.demo-key.validate',
  'organizations.create',
  'organizations.rename',
  'organizations.me.members.list',
  'organizations.members.list',
  'organizations.members.change_role',
  'organizations.members.disable',
  'organizations.members.transfer',
  'organizations.invitations.list',
  'organizations.invitations.create',
  'organizations.invitations.revoke',
  'organizations.invitations.accept',
  'organizations.apiKeys.list',
  'organizations.apiKeys.create',
  'organizations.apiKeys.revoke',
  'organizations.apiKeys.rotate',
  'organizations.identityConfig.read',
  'organizations.identityConfig.set',
  'organizations.auditEvents.list',
  'me.profile.read',
]);

interface TieredRoute {
  readonly method: string;
  readonly path: string;
  readonly tier: RequestTier;
}

/** Path template to an anchored pattern, compiled once per route. */
function patternOf(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((segment) =>
      /^\{[^/{}]+\}$/.test(segment) || /^:[^/]+$/.test(segment)
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
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
      tier: CRITICAL_ROUTE_IDS.has(routeId)
        ? ('critical' as const)
        : ('standard' as const),
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
    pattern: patternOf(route.path),
    tier: route.tier,
  }),
);

/**
 * Infrastructure paths that never carry customer work. A refused probe or
 * scrape tells the load balancer and Prometheus that the whole instance is
 * dead, which is worse than the capacity it saves.
 */
const INFRASTRUCTURE_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/metrics',
]);

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
  if (INFRASTRUCTURE_PATHS.has(path)) return 'critical';

  const exact = EXACT_TIERS.get(`${method} ${path}`);
  if (exact !== undefined) return exact;

  return (
    TEMPLATED_TIERS.find(
      (candidate) =>
        candidate.method === method && candidate.pattern.test(path),
    )?.tier ?? 'critical'
  );
}

/**
 * Whether a tier is refused at a shedding level. `critical` never is: a caller
 * refused at authentication or billing cannot even learn to slow down, and the
 * dispatch that saturates the host is what shedding is for.
 */
export function shedsAtLevel(tier: RequestTier, level: number): boolean {
  if (tier === 'critical') return false;
  return tier === 'best-effort' ? level >= 1 : level >= 2;
}
