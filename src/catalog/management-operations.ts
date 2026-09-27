import type { TSchema } from '@sinclair/typebox';

import type { HttpStatus } from '../common/errors/error-registry';
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
import type { IdempotencyMode } from './operation-catalog';

/**
 * How a Control-plane operation learns which Organization it acts on.
 *
 * `path` means the caller named it in the route. `caller` means the route
 * carries no organization segment: the Organization is the one the Bearer
 * identity already belongs to, or — for `organizations.create` — does not yet
 * exist. Reading this field is the only way to tell those two apart, and a
 * generator that assumed `path` would publish an `organization_id` parameter
 * the route does not accept.
 */
export type OrganizationResolution = 'path' | 'caller';

export interface ManagementOperationDef {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Nest form, so a route declaration can bind it directly. */
  readonly path: string;
  readonly organizationResolution: OrganizationResolution;
  readonly successStatus: 200 | 201 | 204;
  readonly idempotency: IdempotencyMode;
  /** `null` for a bodyless operation, not an optional field. */
  readonly requestSchema: TSchema | null;
  /** `null` for the bodyless `204`. */
  readonly responseSchema: TSchema | null;
  readonly errorStatuses: readonly HttpStatus[];
}

/**
 * Every Control-plane operation, in the order the OpenAPI document lists them.
 *
 * This is not the Operation Catalog and must not become one. A Control-plane
 * operation dispatches nothing, so it has no downstream service, no downstream
 * path, and no API-key scope; `OperationId` is the dispatch vocabulary, and
 * widening it with non-dispatch ids would force a `dispatch()` overload per
 * management route (ADR-0059).
 *
 * Parameter descriptions, response prose, and query parameter shapes stay with
 * the builder's per-operation path items. This registry owns the parts that
 * were previously written in three places at once.
 */
export const MANAGEMENT_OPERATIONS = {
  'organizations.create': {
    method: 'POST',
    path: '/v1/organizations',
    organizationResolution: 'caller',
    successStatus: 201,
    idempotency: 'optional',
    requestSchema: CreateOrganizationRequestSchema,
    responseSchema: CreateOrganizationResponseSchema,
    errorStatuses: [400, 401, 409, 500],
  },
  'organizations.rename': {
    method: 'PATCH',
    path: '/v1/organizations/:organizationId',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: RenameOrganizationRequestSchema,
    responseSchema: RenameOrganizationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.me.members.list': {
    method: 'GET',
    path: '/v1/organizations/me/members',
    organizationResolution: 'caller',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationRosterResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.members.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/members',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipListResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.members.change_role': {
    method: 'PATCH',
    path: '/v1/organizations/:organizationId/members/:username',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: OrganizationMembershipMutationRequestSchema,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.disable': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/members/:username',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.transfer': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/members/:username/transfer',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.invitations.create': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/invitations',
    organizationResolution: 'path',
    successStatus: 201,
    idempotency: 'optional',
    requestSchema: CreateOrganizationInvitationRequestSchema,
    responseSchema: CreateOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 409, 429, 500, 503],
  },
  'organizations.invitations.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/invitations',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOpenOrganizationInvitationsResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.invitations.revoke': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/invitations/:invitationId',
    organizationResolution: 'path',
    successStatus: 204,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [401, 403, 404, 500],
  },
  'organizations.invitations.accept': {
    method: 'POST',
    path: '/v1/organizations/invitations/accept',
    organizationResolution: 'caller',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: AcceptOrganizationInvitationRequestSchema,
    responseSchema: AcceptOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.apiKeys.create': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys',
    organizationResolution: 'path',
    successStatus: 201,
    idempotency: 'none',
    requestSchema: CreateOrganizationApiKeyRequestSchema,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [400, 401, 403, 500, 503],
  },
  'organizations.apiKeys.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/api-keys',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOrganizationApiKeysResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.apiKeys.rotate': {
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId/rotate',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.apiKeys.revoke': {
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: RevokeOrganizationApiKeyResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.identityConfig.read': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/identity-config',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.identityConfig.set': {
    method: 'PUT',
    path: '/v1/organizations/:organizationId/identity-config',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: SetOrganizationIdentityConfigRequestSchema,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [400, 401, 403, 409, 500, 503],
  },
  'organizations.auditEvents.list': {
    method: 'GET',
    path: '/v1/organizations/:organizationId/audit-events',
    organizationResolution: 'path',
    successStatus: 200,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOrganizationAuditEventsResponseSchema,
    errorStatuses: [400, 401, 403, 500, 503],
  },
} as const satisfies Record<string, ManagementOperationDef>;

export type ManagementOperationId = keyof typeof MANAGEMENT_OPERATIONS;
