import type { HttpStatus } from '@/common/errors/error-registry';
/**
 * Public API Route registry: the aggregate of the route-group modules under
 * `./public-routes/`. Spread order is the document order; see
 * `public-route-groups.spec.ts` before changing it.
 */
import type { TSchema } from '@sinclair/typebox';
import type {
  CacheControlPolicy,
  PublicRouteOpenApiMetadata,
} from './openapi-operation-metadata';
import type { IdempotencyMode } from './operation-catalog';
import type { OperationId } from './operation-id';
import {
  AUTH_PUBLIC_ROUTES,
  WEB_SESSION_PUBLIC_ROUTES,
} from './public-routes/auth';
import {
  AVATAR_PUBLIC_ROUTES,
  ME_PUBLIC_ROUTES,
  SANDBOX_PUBLIC_ROUTES,
} from './public-routes/identity';
import { ORGANIZATION_CONTROL_PUBLIC_ROUTES } from './public-routes/organization-control';
import { ORGANIZATION_MEMBERS_PUBLIC_ROUTES } from './public-routes/organization-members';
import { REFERENCE_PUBLIC_ROUTES } from './public-routes/reference';
import { SPEAKING_PUBLIC_ROUTES } from './public-routes/speaking';
import { WRITING_PUBLIC_ROUTES } from './public-routes/writing';

/**
 * How a route learns who is calling it, which decides the `security` entry the
 * document publishes.
 */
/**
 * `bff-client-secret` is the static Customer Web BFF secret in
 * `X-AIHUB-Client-Secret`. It is a caller-auth kind of its own rather than a
 * variant of `api-key` because it identifies a BFF, not an Organization, and
 * because the document must label it as server-to-server only.
 *
 * `bff-api-key` is an Organization API key presented through the Customer Web
 * BFF: the route needs both the `X-API-Key` credential and the BFF secret.
 */
export type CallerAuth =
  | 'bearer'
  | 'refresh-cookie'
  | 'api-key'
  | 'bff-client-secret'
  | 'bff-api-key'
  | 'none';

/**
 * How a route learns which Organization it acts on.
 *
 * `path` means the caller named it in the route. `caller` means the route
 * carries no organization segment: the Organization is the one the caller's
 * credential already belongs to, or — for `organizations.create` — does not yet
 * exist. `none` means the route acts on no Organization at all. Reading this
 * field is the only way to tell those apart, and a generator that assumed
 * `path` would publish an `organization_id` parameter the route does not accept.
 */
export type OrganizationResolution = 'path' | 'caller' | 'none';

/**
 * The statuses an operation may return besides its success status.
 *
 * `'all-except-idempotency-conflict'` derives the list from the error registry
 * the way a dispatch operation does, and is for the one route that reports a
 * `409` it can never reach. Prefer a literal list: it is the only form that
 * fails when a new error code appears.
 */
export type ErrorStatuses =
  | readonly HttpStatus[]
  | 'all-except-idempotency-conflict';

type SuccessStatus = 200 | 201 | 202 | 204;

/**
 * A success status a route answers instead of `successStatus` for some
 * requests. The OpenAPI document publishes each one from this declaration,
 * with the route's `Cache-Control` header and no other success header, so a
 * runtime branch that answers a status missing here is one the document
 * cannot describe.
 */
export interface AlternateSuccess {
  readonly status: SuccessStatus;
  readonly description: string;
  /** `null` when this answer has no body. */
  readonly responseSchema: TSchema | null;
}

export interface PublicRouteDef {
  readonly openApi?: PublicRouteOpenApiMetadata;
  readonly cacheControl?: CacheControlPolicy;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Nest form, so a route declaration can bind it directly. */
  readonly path: string;
  /** Ingress-to-response deadline for non-grading work; shared by every outbound call. */
  readonly timeoutMs?: number;
  readonly callerAuth: CallerAuth;
  /** The API-key scope enforced by this route, when the key has a fixed scope. */
  readonly requiredScope?: string;
  /** Additional scopes accepted in place of `requiredScope`. */
  readonly acceptedScopes?: readonly string[];
  readonly organizationResolution: OrganizationResolution;
  readonly successStatus: SuccessStatus;
  readonly alternateSuccesses?: readonly AlternateSuccess[];
  readonly sunset?: {
    readonly deprecationAt: string;
    readonly sunsetAt: string;
    readonly successorRouteId?: PublicRouteId | OperationId;
    readonly rationale: string;
  };
  /**
   * What the document publishes as `x-identity-scope`, or `null` when the
   * document omits the extension.
   *
   *   - `user` — the operation resolves an End-User ID from a User Identity.
   *     Only these publish the `X-User-Identity` parameter, and a guard test
   *     holds that equivalence both ways.
   *   - `organization` — the operation acts on an Organization. No route in
   *     this registry consumes a User Identity.
   *   - `none` — the operation resolves no identity.
   *   - `null` — the document omits the extension. `speaking.questions` is the
   *     only one: an anonymous read of published prompts that names nothing.
   *
   * This used to record what the document happened to publish rather than what
   * it should, and the two had drifted: the eighteen Organization routes
   * published `user` while consuming no User Identity, which told a generated
   * client to send a header the route rejects.
   */
  readonly publishedIdentityScope: 'user' | 'none' | 'organization' | null;
  readonly idempotency: IdempotencyMode;
  /** `null` for a route that takes no body, not an optional field. */
  readonly requestSchema: TSchema | null;
  /**
   * `null` when the success response has no body. Every route that returns a
   * body names its contract schema, including the routes that were once the
   * only exception.
   */
  readonly responseSchema: TSchema | null;
  readonly errorStatuses: ErrorStatuses;
}

/**
 * Every Public API Route that does not dispatch to an AI Service.
 *
 * This is not the Operation Catalog and must not become one. These routes have
 * no downstream service, no downstream path, or downstream contract; a route
 * may still declare an API-key scope. `OperationId` is the dispatch vocabulary, and widening it with
 * non-dispatch ids would force a `dispatch()` overload per route here
 * (ADR-0059). The two registries partition the Public API Routes rather than
 * duplicating them. Three tests hold that partition from opposite sides:
 * `app.module.spec.ts` proves every registered route is documented,
 * `build-openapi-document.spec.ts` proves the document holds nothing beyond the
 * two registries' paths, and `public-route-groups.spec.ts` proves every declared
 * id is present exactly once and no id belongs to both registries. None is
 * sufficient alone.
 *
 * OpenAPI descriptions and route-specific parameters live beside these route
 * declarations; the shared builder supplies their repeated operation shape.
 * Specialized responses stay in the dedicated OpenAPI builders. The builder
 * publishes every entry with `openApi` metadata in declaration order, so moving
 * an entry reorders the OpenAPI document and the Postman collection.
 */
export const PUBLIC_ROUTES = {
  ...REFERENCE_PUBLIC_ROUTES,
  ...SPEAKING_PUBLIC_ROUTES,
  ...WRITING_PUBLIC_ROUTES,
  ...AVATAR_PUBLIC_ROUTES,
  ...ORGANIZATION_MEMBERS_PUBLIC_ROUTES,
  ...ORGANIZATION_CONTROL_PUBLIC_ROUTES,
  ...AUTH_PUBLIC_ROUTES,
  ...ME_PUBLIC_ROUTES,
  ...WEB_SESSION_PUBLIC_ROUTES,
  ...SANDBOX_PUBLIC_ROUTES,
} as const satisfies Record<string, PublicRouteDef>;

export type PublicRouteId = keyof typeof PUBLIC_ROUTES;

/**
 * Tells a declared non-dispatch route id apart from an `OperationId`. The two
 * registries partition the Public API Routes, so a document operation id is
 * either one or the other and never both.
 */
export function isPublicRouteId(value: string): value is PublicRouteId {
  return Object.hasOwn(PUBLIC_ROUTES, value);
}
