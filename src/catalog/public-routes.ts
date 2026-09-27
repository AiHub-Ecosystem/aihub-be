import type { TSchema } from '@sinclair/typebox';

import type { HttpStatus } from '../common/errors/error-registry';
import {
  EmptyAuthRequestSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
} from '../contracts/auth/local-auth';
import {
  CreateOrganizationApiKeyRequestSchema,
  ListOrganizationApiKeysResponseSchema,
  OrganizationApiKeySecretResponseSchema,
  RevokeOrganizationApiKeyResponseSchema,
} from '../contracts/organization/api-key';
import { ListOrganizationAuditEventsResponseSchema } from '../contracts/organization/audit-event';
import {
  ReadOrganizationIdentityConfigResponseSchema,
  SetOrganizationIdentityConfigRequestSchema,
} from '../contracts/organization/identity-config';
import {
  AcceptOrganizationInvitationRequestSchema,
  AcceptOrganizationInvitationResponseSchema,
  CreateOrganizationInvitationRequestSchema,
  CreateOrganizationInvitationResponseSchema,
  ListOpenOrganizationInvitationsResponseSchema,
} from '../contracts/organization/invitation';
import {
  OrganizationMembershipListResponseSchema,
  OrganizationMembershipMutationRequestSchema,
  OrganizationMembershipMutationResponseSchema,
  OrganizationRosterResponseSchema,
} from '../contracts/organization/membership';
import {
  CreateOrganizationRequestSchema,
  CreateOrganizationResponseSchema,
  RenameOrganizationRequestSchema,
  RenameOrganizationResponseSchema,
} from '../contracts/organization/organization';
import {
  MintSandboxAssertionRequestSchema,
  MintSandboxAssertionResponseSchema,
} from '../contracts/sandbox/assertion';
import type { IdempotencyMode } from './operation-catalog';

/**
 * How a route learns who is calling it, which decides the `security` entry the
 * document publishes.
 */
export type CallerAuth = 'bearer' | 'refresh-cookie' | 'api-key' | 'none';

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

export interface PublicRouteDef {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Nest form, so a route declaration can bind it directly. */
  readonly path: string;
  readonly callerAuth: CallerAuth;
  readonly organizationResolution: OrganizationResolution;
  readonly successStatus: 200 | 201 | 202 | 204;
  /**
   * The value the document publishes as `x-identity-scope`, or `null` when the
   * document omits the extension.
   *
   * This is named for what it is — a published vendor-extension value — and not
   * as an "identity mode", because it is not one thing. Across this document it
   * is `user` for the dispatch operations and for the eighteen Organization
   * routes (which consume no User Identity at all), `none` for the local auth
   * routes, `organization` for the sandbox mint, and absent for the Speaking
   * question list. Declaring it here gathers that into one place, which is where
   * it becomes visible enough to be worth a decision; it does not resolve it.
   */
  readonly publishedIdentityScope: 'user' | 'none' | 'organization' | null;
  readonly idempotency: IdempotencyMode;
  /** `null` for a route that takes no body, not an optional field. */
  readonly requestSchema: TSchema | null;
  /**
   * `null` when the success response has no body, or when no contract schema
   * exists to name. `speaking.questions` is the latter: its envelope is built
   * where the document is built and has never had a contract module.
   */
  readonly responseSchema: TSchema | null;
  readonly errorStatuses: ErrorStatuses;
}

/**
 * Every Public API Route that does not dispatch to an AI Service.
 *
 * This is not the Operation Catalog and must not become one. These routes have
 * no downstream service, no downstream path, no downstream contract, and no
 * API-key scope; `OperationId` is the dispatch vocabulary, and widening it with
 * non-dispatch ids would force a `dispatch()` overload per route here
 * (ADR-0059). The two registries partition the Public API Routes rather than
 * duplicating them. Two tests hold that partition from opposite sides:
 * `app.module.spec.ts` proves every registered route is documented, and
 * `build-openapi-document.spec.ts` proves the document holds nothing beyond the
 * two registries' paths. Neither is sufficient alone.
 *
 * Parameter descriptions, response prose, query parameter shapes, and the
 * `x-identity-scope` extension stay with the builder's per-route path items.
 * `x-identity-scope` in particular carries four different published values
 * across this document, so declaring it here would enshrine the inconsistency
 * rather than record a fact.
 */
export const PUBLIC_ROUTES = {
  'organizations.create': {
    method: 'POST',
    path: '/v1/organizations',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'optional',
    requestSchema: CreateOrganizationRequestSchema,
    responseSchema: CreateOrganizationResponseSchema,
    errorStatuses: [400, 401, 409, 500],
  },
  'organizations.rename': {
    method: 'PATCH',
    path: '/v1/organizations/:organizationId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: RenameOrganizationRequestSchema,
    responseSchema: RenameOrganizationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.me.members.list': {
    method: 'GET',
    path: '/v1/organizations/me/members',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationRosterResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.members.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/members',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipListResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.members.change_role': {
    method: 'PATCH',
    path: '/v1/organizations/:organizationId/members/:username',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: OrganizationMembershipMutationRequestSchema,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.disable': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/members/:username',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.transfer': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/members/:username/transfer',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.invitations.create': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/invitations',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'optional',
    requestSchema: CreateOrganizationInvitationRequestSchema,
    responseSchema: CreateOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 409, 429, 500, 503],
  },
  'organizations.invitations.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/invitations',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOpenOrganizationInvitationsResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.invitations.revoke': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/invitations/:invitationId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 204,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [401, 403, 404, 500],
  },
  'organizations.invitations.accept': {
    method: 'POST',
    path: '/v1/organizations/invitations/accept',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: AcceptOrganizationInvitationRequestSchema,
    responseSchema: AcceptOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.apiKeys.create': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: CreateOrganizationApiKeyRequestSchema,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [400, 401, 403, 500, 503],
  },
  'organizations.apiKeys.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/api-keys',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOrganizationApiKeysResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.apiKeys.rotate': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId/rotate',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.apiKeys.revoke': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: RevokeOrganizationApiKeyResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.identityConfig.read': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/identity-config',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.identityConfig.set': {
    method: 'PUT',
    path: '/v1/organizations/:organizationId/identity-config',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: SetOrganizationIdentityConfigRequestSchema,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [400, 401, 403, 409, 500, 503],
  },
  'organizations.auditEvents.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/audit-events',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOrganizationAuditEventsResponseSchema,
    errorStatuses: [400, 401, 403, 500, 503],
  },
  'auth.register': {
    method: 'POST',
    path: '/v1/auth/register',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 201,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: RegisterRequestSchema,
    responseSchema: RegisterResponseSchema,
    errorStatuses: [400, 409, 429, 500, 503],
  },
  'auth.login': {
    method: 'POST',
    path: '/v1/auth/login',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: LoginRequestSchema,
    responseSchema: LoginResponseSchema,
    errorStatuses: [400, 401, 429, 500],
  },
  'auth.verify_email': {
    method: 'POST',
    path: '/v1/auth/verify-email',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: VerifyEmailRequestSchema,
    responseSchema: LoginResponseSchema,
    errorStatuses: [400, 429, 500],
  },
  'auth.resend_verification': {
    method: 'POST',
    path: '/v1/auth/resend-verification',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 202,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ResendVerificationRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 429, 500],
  },
  'auth.forgot_password': {
    method: 'POST',
    path: '/v1/auth/forgot-password',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 202,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ForgotPasswordRequestSchema,
    responseSchema: ForgotPasswordResponseSchema,
    errorStatuses: [400, 429, 500],
  },
  'auth.reset_password': {
    method: 'POST',
    path: '/v1/auth/reset-password',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ResetPasswordRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 429, 500],
  },
  'auth.refresh': {
    method: 'POST',
    path: '/v1/auth/refresh',
    callerAuth: 'refresh-cookie',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: EmptyAuthRequestSchema,
    responseSchema: LoginResponseSchema,
    errorStatuses: [400, 429, 500],
  },
  'auth.logout': {
    method: 'POST',
    path: '/v1/auth/logout',
    callerAuth: 'refresh-cookie',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: EmptyAuthRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 500],
  },
  'sandbox.assertions.mint': {
    method: 'POST',
    path: '/v1/sandbox/assertions',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: MintSandboxAssertionRequestSchema,
    responseSchema: MintSandboxAssertionResponseSchema,
    errorStatuses: 'all-except-idempotency-conflict',
  },
  'speaking.questions': {
    method: 'GET',
    path: '/v1/ielts/speaking/questions',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [400, 500],
  },
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
