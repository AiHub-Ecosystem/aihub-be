import type { TSchema } from '@sinclair/typebox';
import type { OperationId } from './operation-id';

import type { HttpStatus } from '@/common/errors/error-registry';
import {
  EmptyAuthRequestSchema,
  ForgotPasswordRequestSchema,
  ForgotPasswordResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  LoginResultResponseSchema,
  ReadCurrentUserResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  ResendVerificationRequestSchema,
  ResetPasswordRequestSchema,
  VerifyEmailRequestSchema,
} from '@/contracts/auth/local-auth';
import {
  BeginMfaEnrollmentRequestSchema,
  BeginMfaEnrollmentResponseSchema,
  ConfirmMfaEnrollmentRequestSchema,
  ConfirmMfaEnrollmentResponseSchema,
  RemoveMfaFactorRequestSchema,
} from '@/contracts/auth/mfa';
import {
  CreateWebSessionFromVerificationRequestSchema,
  CreateWebSessionRequestSchema,
  CreateWebSessionResponseSchema,
  CreateWebSessionResultResponseSchema,
  ExchangeWebSessionRequestSchema,
  LogoutWebSessionRequestSchema,
} from '@/contracts/auth/web-session';
import {
  AvatarResponseSchema,
  AvatarUploadResponseSchema,
  CreateAvatarUploadRequestSchema,
  ReadAvatarResponseSchema,
} from '@/contracts/avatar/avatar';
import {
  CreateOrganizationApiKeyRequestSchema,
  ListOrganizationApiKeysResponseSchema,
  OrganizationApiKeySecretResponseSchema,
  RevokeOrganizationApiKeyResponseSchema,
} from '@/contracts/organization/api-key';
import {
  DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
  ListOrganizationAuditEventsResponseSchema,
  MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
} from '@/contracts/organization/audit-event';
import {
  ReadOrganizationIdentityConfigResponseSchema,
  SetOrganizationIdentityConfigRequestSchema,
} from '@/contracts/organization/identity-config';
import {
  AcceptOrganizationInvitationRequestSchema,
  AcceptOrganizationInvitationResponseSchema,
  CreateOrganizationInvitationRequestSchema,
  CreateOrganizationInvitationResponseSchema,
  ListOpenOrganizationInvitationsResponseSchema,
} from '@/contracts/organization/invitation';
import {
  OrganizationMembershipListResponseSchema,
  OrganizationMembershipMutationRequestSchema,
  OrganizationMembershipMutationResponseSchema,
  OrganizationRosterResponseSchema,
} from '@/contracts/organization/membership';
import {
  CreateOrganizationRequestSchema,
  CreateOrganizationResponseSchema,
  RenameOrganizationRequestSchema,
  RenameOrganizationResponseSchema,
} from '@/contracts/organization/organization';
import {
  MintSandboxAssertionRequestSchema,
  MintSandboxAssertionResponseSchema,
} from '@/contracts/sandbox/assertion';
import {
  SandboxDemoKeyValidationRequestSchema,
  SandboxDemoKeyValidationResponseSchema,
} from '@/contracts/sandbox/demo-key-validation';
import {
  CreateSpeakingAudioUploadRequestSchema,
  SpeakingAudioAssetResponseSchema,
  SpeakingAudioUploadUrlResponseSchema,
} from '@/contracts/speaking/audio-upload';
import {
  SpeakingQuestionsQuerySchema,
  SpeakingQuestionsResponseSchema,
} from '@/contracts/speaking/questions';
import {
  CreateWritingChartUploadRequestSchema,
  WritingChartAssetResponseSchema,
  WritingChartUploadGrantResponseSchema,
} from '@/contracts/writing/chart-upload';
import type {
  CacheControlPolicy,
  PublicRouteOpenApiMetadata,
} from './openapi-operation-metadata';
import type { IdempotencyMode } from './operation-catalog';

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

export interface PublicRouteDef {
  readonly openApi?: PublicRouteOpenApiMetadata;
  readonly cacheControl?: CacheControlPolicy;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Nest form, so a route declaration can bind it directly. */
  readonly path: string;
  /** Ingress-to-response deadline for non-grading work; shared by every outbound call. */
  readonly timeoutMs?: number;
  readonly callerAuth: CallerAuth;
  readonly organizationResolution: OrganizationResolution;
  readonly successStatus: 200 | 201 | 202 | 204;
  readonly alternateSuccessStatuses?: readonly (200 | 201 | 202 | 204)[];
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
 * no downstream service, no downstream path, no downstream contract, and no
 * API-key scope; `OperationId` is the dispatch vocabulary, and widening it with
 * non-dispatch ids would force a `dispatch()` overload per route here
 * (ADR-0059). The two registries partition the Public API Routes rather than
 * duplicating them. Two tests hold that partition from opposite sides:
 * `app.module.spec.ts` proves every registered route is documented, and
 * `build-openapi-document.spec.ts` proves the document holds nothing beyond the
 * two registries' paths. Neither is sufficient alone.
 *
 * OpenAPI descriptions and route-specific parameters live beside these route
 * declarations; the shared builder supplies their repeated operation shape.
 * Specialized responses stay in the dedicated OpenAPI builders.
 */
export const PUBLIC_ROUTES = {
  'organizations.create': {
    openApi: {
      summary: 'Create a Self-serve Organization and become its first owner',
      description:
        'Commercial terms are operator-controlled defaults and cannot be set by the request. Each account may create a limited number of Organizations over its lifetime.',
      successDescription:
        'Organization created with the caller as its active owner',
      replayHeaderDescription:
        'Present with value true when the completed creation result was replayed for this key.',
    },
    method: 'POST',
    path: '/v1/organizations',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'organization',
    idempotency: 'optional',
    requestSchema: CreateOrganizationRequestSchema,
    responseSchema: CreateOrganizationResponseSchema,
    errorStatuses: [400, 401, 409, 500],
  },
  'organizations.rename': {
    openApi: {
      summary: 'Rename an organization',
      description:
        'Only an active owner of an active organization may rename it. Every other caller, and a suspended organization, receives the same denial. Commercial terms and status cannot be changed by this request.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization to rename.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription: 'The organization under its current name',
    },
    method: 'PATCH',
    path: '/v1/organizations/:organizationId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: RenameOrganizationRequestSchema,
    responseSchema: RenameOrganizationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.me.members.list': {
    openApi: {
      summary: 'List the authenticated user organization roster',
      description:
        'Returns the Organizations where the authenticated user has an active membership, including suspended Organizations. `identity_configured` reports only whether an active identity configuration is saved; the JWKS source is not probed and its URL or key material is not returned.',
      successDescription: 'Organization roster',
    },
    method: 'GET',
    path: '/v1/organizations/me/members',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationRosterResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.members.list': {
    openApi: {
      summary: "List an organization's memberships",
      description:
        'Active owners and admins may list active or disabled memberships for one active Organization. The filter defaults to active membership and does not depend on the member account status. Results are ordered by immutable username and omit account IDs and email addresses.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose memberships are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'status',
          in: 'query',
          required: false,
          description: 'Membership status to list. Defaults to active.',
          schema: {
            type: 'string',
            enum: ['active', 'disabled'],
            default: 'active',
          },
        },
      ],
      successDescription: 'Organization memberships',
    },
    method: 'GET',
    path: '/v1/organizations/:organizationId/members',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipListResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.members.change_role': {
    openApi: {
      summary: 'Change an organization member role',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose membership is being changed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'username',
          in: 'path',
          required: true,
          description: 'The immutable public username of the target member.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      successDescription: 'The resulting organization membership',
    },
    method: 'PATCH',
    path: '/v1/organizations/:organizationId/members/:username',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: OrganizationMembershipMutationRequestSchema,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.disable': {
    openApi: {
      summary: 'Disable an organization member',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose membership is being changed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'username',
          in: 'path',
          required: true,
          description: 'The immutable public username of the target member.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      successDescription: 'The resulting organization membership',
    },
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/members/:username',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.members.transfer': {
    openApi: {
      summary: 'Transfer organization ownership',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose membership is being changed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'username',
          in: 'path',
          required: true,
          description: 'The immutable public username of the target member.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      successDescription: 'The resulting organization membership',
    },
    method: 'POST',
    path: '/v1/organizations/:organizationId/members/:username/transfer',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationMembershipMutationResponseSchema,
    errorStatuses: [400, 401, 403, 404, 409, 500],
  },
  'organizations.invitations.create': {
    openApi: {
      summary: 'Invite a person to an organization',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization the invited person is invited to.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription:
        'Pending organization invitation created; the single-use invite credential reaches the invited person by email only',
      replayHeaderDescription:
        'Present with value true when the completed invitation result was replayed for this key.',
    },
    method: 'POST',
    path: '/v1/organizations/:organizationId/invitations',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 201,
    publishedIdentityScope: 'organization',
    idempotency: 'optional',
    requestSchema: CreateOrganizationInvitationRequestSchema,
    responseSchema: CreateOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 409, 429, 500, 503],
  },
  'organizations.invitations.list': {
    openApi: {
      summary: "List an organization's open invitations",
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose open invitations are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription: 'Open organization invitations',
    },
    method: 'GET',
    path: '/v1/organizations/:organizationId/invitations',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOpenOrganizationInvitationsResponseSchema,
    errorStatuses: [401, 403, 500],
  },
  'organizations.invitations.revoke': {
    openApi: {
      summary: 'Revoke an organization invitation',
      description:
        'Closes an open invitation using the durable invitation close signal. An already closed or expired invitation is a retry-safe no-op and still returns bodyless 204.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the invitation.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'invitation_id',
          in: 'path',
          required: true,
          description: 'The invitation being revoked.',
          schema: {
            type: 'string',
            pattern: '^oiv_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      successDescription:
        'Invitation closed, or already closed/expired; the response has no body',
    },
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/invitations/:invitationId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 204,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [401, 403, 404, 500],
  },
  'organizations.invitations.accept': {
    openApi: {
      summary: 'Accept an organization invitation',
      successDescription: 'Organization membership granted or reactivated',
    },
    method: 'POST',
    path: '/v1/organizations/invitations/accept',
    callerAuth: 'bearer',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: AcceptOrganizationInvitationRequestSchema,
    responseSchema: AcceptOrganizationInvitationResponseSchema,
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.apiKeys.create': {
    cacheControl: { value: 'no-store' },
    openApi: {
      summary: 'Create an organization API key',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that will own the API key.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription:
        'API key created; the raw credential is returned in this response only and cannot be recovered afterwards. `status` is always `active`: a requested expiry must be in the future, so this response never carries `expired`.',
    },
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 201,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: CreateOrganizationApiKeyRequestSchema,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [400, 401, 403, 500, 503],
  },
  'organizations.apiKeys.list': {
    openApi: {
      summary: 'List an organization API key inventory',
      description:
        'Returns the organization live API keys as metadata only. Revoked keys are absent; `status` is `expired` once a key expiry has passed. `last_used_at` is approximate.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose API keys are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription:
        'Live API key inventory; never a credential hash or raw credential',
    },
    method: 'GET',
    path: '/v1/organizations/:organizationId/api-keys',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ListOrganizationApiKeysResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.apiKeys.rotate': {
    cacheControl: { value: 'no-store' },
    openApi: {
      summary: 'Rotate an organization API key',
      description:
        'Creates a replacement and revokes the named key in one act, with no window in which both work. The replacement inherits the name, scopes, and expiry. It keeps the first stored allowed environment only; a legacy key that allows multiple environments is narrowed to that one environment. Legacy environments without a dedicated key prefix keep the compatibility prefix. The raw credential is returned in this response only. A revoked or expired key cannot be rotated.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the API key.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'api_key_id',
          in: 'path',
          required: true,
          description: 'The API key being retired.',
          schema: { type: 'string', pattern: '^ak_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription:
        'API key rotated; the raw replacement is returned in this response only and cannot be recovered afterwards. `status` is always `active`.',
    },
    method: 'POST',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId/rotate',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: OrganizationApiKeySecretResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.apiKeys.revoke': {
    openApi: {
      summary: 'Revoke an organization API key',
      description:
        'Withdraws the key and keeps its durable row, purging the identity cache so the change takes effect inside the existing cache ceiling. State-idempotent: withdrawing an already withdrawn key succeeds and leaves the recorded moment unchanged. This is the only response from which `revoked` is reachable.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that owns the API key.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'api_key_id',
          in: 'path',
          required: true,
          description: 'The API key being withdrawn.',
          schema: { type: 'string', pattern: '^ak_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'API key withdrawn; its durable row is kept',
    },
    method: 'DELETE',
    path: '/v1/organizations/:organizationId/api-keys/:apiKeyId',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: RevokeOrganizationApiKeyResponseSchema,
    errorStatuses: [401, 403, 404, 500, 503],
  },
  'organizations.identityConfig.read': {
    openApi: {
      summary: 'Read an organization identity configuration',
      description:
        'Returns the stored public Signed User Assertion identity configuration to an active owner of an active Organization. Admins, members, disabled memberships, non-members, and owners of suspended Organizations receive the same Safe Authorization Denial. `configured` indicates whether a row exists, including disabled rows; `status` indicates whether that configuration is active. Private JWK members are never returned.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is read.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription:
        'Stored public identity configuration, or `configured: false` when no row exists.',
    },
    method: 'GET',
    path: '/v1/organizations/:organizationId/identity-config',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [401, 403, 500, 503],
  },
  'organizations.identityConfig.set': {
    openApi: {
      summary: 'Set an organization identity configuration',
      description:
        'Creates or replaces the public Signed User Assertion identity configuration for an active owner of an active Organization. Submit exactly one JWKS source. URL sources are fetched through the SSRF-protected JWKS path before saving. Existing status is preserved. A retryable cache error may mean the durable save succeeded; retrying the same request safely retries cache purge.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is set.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      successDescription:
        'The stored public identity configuration, including its preserved status.',
    },
    method: 'PUT',
    path: '/v1/organizations/:organizationId/identity-config',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: SetOrganizationIdentityConfigRequestSchema,
    responseSchema: ReadOrganizationIdentityConfigResponseSchema,
    errorStatuses: [400, 401, 403, 409, 500, 503],
  },
  'organizations.auditEvents.list': {
    openApi: {
      summary: 'Read an organization audit trail',
      description:
        'Returns the organization recorded control-plane acts, newest first, paginated by an opaque cursor. Active owners and admins may read; members, non-members, and disabled memberships receive one indistinguishable denial. A suspended organization stays readable, because the trail is evidence rather than a management surface. The actor is named by immutable username: no user account id, target id, key hash, or token hash appears. An event whose label has been removed by audit redaction is returned with `target_label` null rather than hidden.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose audit trail is read.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'action',
          in: 'query',
          required: false,
          description:
            'Restrict the trail to these audit actions. Repeat the key for several values; an unrecognized value is rejected rather than treated as an empty filter.',
          style: 'form',
          explode: true,
          schema: {
            type: 'array',
            items: { type: 'string', enum: [...ORGANIZATION_AUDIT_ACTIONS] },
          },
        },
        {
          name: 'outcome',
          in: 'query',
          required: false,
          description:
            'Restrict the trail to acts that took effect, or to refused attempts against a real target.',
          schema: { type: 'string', enum: [...ORGANIZATION_AUDIT_OUTCOMES] },
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          description:
            'Inclusive start of a half-open UTC window. Independent of `to`.',
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'to',
          in: 'query',
          required: false,
          description:
            'Exclusive end of a half-open UTC window, so adjacent windows tile without counting an event twice.',
          schema: { type: 'string', format: 'date-time' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description:
            'Events per page. A value outside the range is rejected rather than clamped, because a silently shortened page is indistinguishable from the end of the trail.',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
            default: DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
          },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opaque position from a previous `next_cursor`. Bound to the filters it was issued under: replaying it with different filters is rejected.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      successDescription:
        'One page of recorded acts, newest first. `next_cursor` is null at the end of the trail.',
    },
    method: 'GET',
    path: '/v1/organizations/:organizationId/audit-events',
    callerAuth: 'bearer',
    organizationResolution: 'path',
    successStatus: 200,
    publishedIdentityScope: 'organization',
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
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/login',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    alternateSuccessStatuses: [202],
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: LoginRequestSchema,
    responseSchema: LoginResultResponseSchema,
    errorStatuses: [400, 401, 429, 500, 503],
  },
  'auth.mfa.enrollment': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/mfa/enrollment',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: BeginMfaEnrollmentRequestSchema,
    responseSchema: BeginMfaEnrollmentResponseSchema,
    errorStatuses: [400, 401, 409, 429, 500, 503],
  },
  'auth.mfa.enrollment.confirm': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/mfa/enrollment/confirm',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ConfirmMfaEnrollmentRequestSchema,
    responseSchema: ConfirmMfaEnrollmentResponseSchema,
    errorStatuses: [400, 401, 429, 500],
  },
  'auth.mfa.remove': {
    cacheControl: { value: 'no-store' },
    method: 'DELETE',
    path: '/v1/auth/mfa',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: RemoveMfaFactorRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 401, 429, 500, 503],
  },
  'auth.verify_email': {
    cacheControl: { value: 'no-store' },
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
    errorStatuses: [400, 429, 500, 503],
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
    errorStatuses: [400, 429, 500, 503],
  },
  'auth.reset_password': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/reset-password',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ResetPasswordRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 429, 500, 503],
  },
  'auth.refresh': {
    cacheControl: { value: 'no-store' },
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
    cacheControl: { value: 'no-store' },
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
  'me.profile.read': {
    cacheControl: { value: 'no-store' },
    method: 'GET',
    path: '/v1/me',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadCurrentUserResponseSchema,
    errorStatuses: [401, 500, 503],
  },
  'auth.web_sessions.create': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/web-sessions',
    callerAuth: 'bff-client-secret',
    organizationResolution: 'none',
    successStatus: 201,
    alternateSuccessStatuses: [202],
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: CreateWebSessionRequestSchema,
    responseSchema: CreateWebSessionResultResponseSchema,
    errorStatuses: [400, 401, 429, 500, 503],
  },
  'auth.web_sessions.verification': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/web-sessions/verification',
    callerAuth: 'bff-client-secret',
    organizationResolution: 'none',
    successStatus: 201,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: CreateWebSessionFromVerificationRequestSchema,
    responseSchema: CreateWebSessionResponseSchema,
    errorStatuses: [400, 401, 429, 500, 503],
  },
  // The stateless exchange. Same envelope as login, no cookie, and AIHUB keeps
  // no record of the JWT it signs: only the sliding session expiry is durable.
  'auth.web_sessions.exchange': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/web-sessions/exchange',
    callerAuth: 'bff-client-secret',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: ExchangeWebSessionRequestSchema,
    responseSchema: LoginResponseSchema,
    errorStatuses: [400, 401, 429, 500, 503],
  },
  // Idempotent and quiet, so the route has no session failure to report and no
  // rate-limit dimension of its own: a valid, revoked, unknown, expired, and
  // malformed token all answer the same bodyless 204. Only the presented session
  // is revoked, and there is no "log out all devices" route.
  'auth.web_sessions.logout': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/auth/web-sessions/logout',
    callerAuth: 'bff-client-secret',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: LogoutWebSessionRequestSchema,
    responseSchema: null,
    errorStatuses: [400, 401, 500, 503],
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
  'sandbox.demo-key.validate': {
    cacheControl: { value: 'no-store' },
    method: 'POST',
    path: '/v1/sandbox/demo/api-keys/validate',
    callerAuth: 'bff-api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'organization',
    idempotency: 'none',
    requestSchema: SandboxDemoKeyValidationRequestSchema,
    responseSchema: SandboxDemoKeyValidationResponseSchema,
    errorStatuses: [400, 401, 403, 429, 500, 503],
  },
  'me.avatar.uploads.create': {
    cacheControl: { value: 'no-store' },
    openApi: {
      summary: 'Request an Avatar upload URL',
      description:
        'Mints a presigned `PUT` URL that writes one object for the signed-in AIHUB User Account, with the declared content type and `Cache-Control: public, max-age=3600` bound into the signature. `Content-Length` reports the declared size but is not signed because browser Fetch controls it; send the image as the request body and let the browser manage that header. The bytes go straight to storage, never through AIHUB. Nothing is recorded until completion verifies the stored object, including its actual size and type, within one hour of upload. Allowed types are `image/jpeg`, `image/png`, and `image/webp`, up to 2 MiB; the URL expires after 5 minutes. An account that already has an Avatar may request one to replace it.',
      successDescription:
        'Upload URL minted. The URL is a write credential for one object and is returned only here.',
    },
    method: 'POST',
    path: '/v1/me/avatar/uploads',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 201,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: CreateAvatarUploadRequestSchema,
    responseSchema: AvatarUploadResponseSchema,
    errorStatuses: [400, 401, 413, 500, 503],
  },
  // `201` when this call records the Avatar, first or replacement; a repeated
  // completion of the same asset answers `200` with the same body, which the
  // path item documents.
  'me.avatar.uploads.complete': {
    openApi: {
      summary: 'Complete an Avatar upload',
      description:
        'Checks the object that actually landed for this asset and records it as the Avatar of the signed-in AIHUB User Account. An object that is missing, or that was stored more than an hour ago, answers `404` and an expired one is deleted; one that is larger than 2 MiB, has an unsupported type, or is empty is refused and deleted. When the account already has a different Avatar, its image is deleted first and the new one replaces it; if that delete fails the account keeps its Avatar and the call answers `503`, and retrying finishes the replacement. `409 AVATAR_CHANGED` means another request changed the Avatar first; re-read before retrying. The response describes the image, including its published `url`.',
      parameters: [
        {
          name: 'asset_id',
          in: 'path',
          required: true,
          description: 'The asset id returned when the upload URL was minted.',
          schema: { type: 'string', pattern: '^ava_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'Avatar recorded by this call, first or replacement.',
      alternateSuccessResponses: [
        {
          status: 200,
          description:
            'This asset was already recorded as the Avatar by an earlier completion; the same Avatar is returned.',
        },
      ],
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/me/avatar/uploads/:assetId/complete',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 201,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: AvatarResponseSchema,
    errorStatuses: [400, 401, 404, 409, 413, 500, 503],
  },
  // Always `200`: an account with no Avatar answers `avatar: null`.
  'me.avatar.read': {
    openApi: {
      summary: 'Read the Avatar',
      description:
        'Describes the Avatar of the signed-in AIHUB User Account, or answers `avatar: null` when the account has none; that is a normal state, not an error. `url` is the published origin URL of the image: load it with a plain unauthenticated `GET`, which AIHUB does not proxy. Each upload has a new URL, and a removed image may stay in caches for up to an hour.',
      successDescription: 'The Avatar, or `null` when the account has none.',
    },
    method: 'GET',
    path: '/v1/me/avatar',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: ReadAvatarResponseSchema,
    errorStatuses: [401, 500, 503],
  },
  // Always `204`, including for an account with no Avatar: absence is what
  // was asked for.
  'me.avatar.remove': {
    openApi: {
      summary: 'Remove the Avatar',
      description:
        'Deletes the Avatar image and its record for the signed-in AIHUB User Account. Idempotent: an account with no Avatar also answers `204`. If the image cannot be deleted the account keeps its Avatar and the call answers `503`; retrying finishes the removal. `409 AVATAR_CHANGED` means another request replaced the Avatar meanwhile, and the replacement is kept.',
      successDescription: 'The account has no Avatar.',
    },
    method: 'DELETE',
    timeoutMs: 10_000,
    path: '/v1/me/avatar',
    callerAuth: 'bearer',
    organizationResolution: 'none',
    successStatus: 204,
    publishedIdentityScope: 'none',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: null,
    errorStatuses: [401, 409, 500, 503],
  },
  'speaking.questions': {
    cacheControl: {
      value: 'no-store',
      description: 'This response must not be cached.',
    },
    openApi: {
      summary: 'List Speaking questions',
      includeCorrelationId: false,
      parameters: [
        {
          name: 'part',
          in: 'query',
          required: false,
          description: 'Filter by Speaking part; omit to list all parts.',
          schema: SpeakingQuestionsQuerySchema.properties.part,
        },
      ],
      successDescription: 'Speaking questions and signed audio URLs',
    },
    method: 'GET',
    path: '/v1/ielts/speaking/questions',
    callerAuth: 'none',
    organizationResolution: 'none',
    successStatus: 200,
    publishedIdentityScope: null,
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingQuestionsResponseSchema,
    errorStatuses: [400, 500],
  },
  'speaking.audioUploads.create': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Create a Speaking Audio upload intent',
      description: [
        'Creates a one-hour intent bound to the Organization and exact End-User ID resolved from `X-User-Identity`. The response contains a five-minute presigned `PUT` URL; send the audio directly to that URL with the returned `Content-Type` and `Content-Length` headers.',
        'The URL is a write credential. Do not log, persist, or expose it. The intent is not an Audio asset until completion verifies the stored object.',
      ].join('\n\n'),
      successDescription:
        'Returns the same server-generated key and signed headers for the upload intent.',
    },
    method: 'POST',
    path: '/v1/speaking/audio/uploads',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: CreateSpeakingAudioUploadRequestSchema,
    responseSchema: SpeakingAudioUploadUrlResponseSchema,
    errorStatuses: [400, 401, 403, 413, 429, 500, 503],
  },
  'speaking.audioUploads.refresh': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Refresh a Speaking Audio upload URL',
      description:
        'Issues another five-minute URL for the same open intent, key, content type, and byte size. It does not extend the original one-hour intent expiry.',
      parameters: [
        {
          name: 'assetId',
          in: 'path',
          required: true,
          description:
            'The asset ID returned when the upload intent was created.',
          schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription:
        'Returns the same server-generated key and signed headers for the upload intent.',
    },
    method: 'POST',
    path: '/v1/speaking/audio/uploads/:assetId/refresh',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingAudioUploadUrlResponseSchema,
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
  },
  'speaking.audioUploads.complete': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and Audio metadata must not be cached.',
    },
    openApi: {
      summary: 'Complete a Speaking Audio upload',
      description: [
        'Verifies the stored object metadata at the exact key recorded by the intent. A valid object creates the Audio asset and sets `retention_expires_at` to 30 days after acceptance; a missing object leaves the intent retryable, while invalid metadata rejects the intent.',
        'Only the same Organization and End-User ID can complete the intent. Repeating a successful completion returns the same Audio asset.',
      ].join('\n\n'),
      parameters: [
        {
          name: 'assetId',
          in: 'path',
          required: true,
          description:
            'The asset ID returned when the upload intent was created.',
          schema: { type: 'string', pattern: '^aud_[0-9A-HJKMNP-TV-Z]{26}$' },
        },
      ],
      successDescription: 'The verified Audio asset created by this request.',
      alternateSuccessResponses: [
        {
          status: 200,
          description:
            'This intent was already completed; the same Audio asset is returned.',
        },
      ],
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/speaking/audio/uploads/:assetId/complete',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: SpeakingAudioAssetResponseSchema,
    errorStatuses: [400, 401, 403, 404, 413, 429, 500, 503],
  },
  'writing.chartUploads.create': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Create a Writing Task 1 chart upload intent',
      description: [
        'Requires an API key with `writing.grade` and the same declared or signed `X-User-Identity` accepted by Writing Task 1 grading. The intent is bound to that Organization, End User, and API-key environment.',
        'Upload directly to the returned URL as `multipart/form-data`, including every returned `fields` entry and the file under `file`. The signed policy limits the stored file to the declared byte size. Staging remains private. The policy expires after five minutes; the intent expires after one hour and can be refreshed without extending that deadline. Limits are five intents and five published charts per Organization in a rolling hour.',
      ].join('\n\n'),
      successDescription:
        'A five-minute signed POST policy and form fields for private staging storage, limited to the declared byte size.',
    },
    method: 'POST',
    path: '/v1/ielts/writing/task1/chart-uploads',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 201,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: CreateWritingChartUploadRequestSchema,
    responseSchema: WritingChartUploadGrantResponseSchema,
    errorStatuses: [400, 401, 403, 413, 429, 500, 503],
  },
  'writing.chartUploads.refresh': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Refresh a Writing Task 1 chart upload URL',
      description:
        'Refreshes the signed URL for the same private staging object without extending the intent deadline.',
      parameters: [
        {
          name: 'assetId',
          in: 'path',
          required: true,
          description:
            'The chart asset ID returned when the upload intent was created.',
          schema: {
            type: 'string',
            pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      successDescription:
        'A five-minute signed POST policy and form fields for private staging storage, limited to the declared byte size.',
    },
    method: 'POST',
    path: '/v1/ielts/writing/task1/chart-uploads/:assetId/refresh',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingChartUploadGrantResponseSchema,
    errorStatuses: [400, 401, 403, 404, 429, 500, 503],
  },
  'writing.chartUploads.complete': {
    cacheControl: {
      value: 'no-store',
      description: 'Upload URLs and chart metadata must not be cached.',
    },
    openApi: {
      summary: 'Verify and publish a Writing Task 1 chart',
      description: [
        'Downloads the complete staged object (up to 10 MiB), decodes and verifies the JPEG, PNG, or WebP image, applies EXIF orientation, strips source metadata, and re-encodes it before publishing the sanitized bytes. Completion returns 413 and rejects the intent if the sanitized output exceeds 10 MiB; malformed or mismatched images are rejected with 400.',
        'The returned `image_url` is anonymously readable and shareable until it expires 24 hours after publication. Anyone who learns the URL can read and reuse it. Only the same Organization, End User, and environment can complete the upload.',
      ].join('\n\n'),
      parameters: [
        {
          name: 'assetId',
          in: 'path',
          required: true,
          description:
            'The chart asset ID returned when the upload intent was created.',
          schema: {
            type: 'string',
            pattern: '^chart_[0-9A-HJKMNP-TV-Z]{26}$',
          },
        },
      ],
      successDescription: 'The public image URL and its fixed expiration time.',
    },
    method: 'POST',
    timeoutMs: 10_000,
    path: '/v1/ielts/writing/task1/chart-uploads/:assetId/complete',
    callerAuth: 'api-key',
    organizationResolution: 'caller',
    successStatus: 200,
    publishedIdentityScope: 'user',
    idempotency: 'none',
    requestSchema: null,
    responseSchema: WritingChartAssetResponseSchema,
    errorStatuses: [400, 401, 403, 404, 413, 429, 500, 503],
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
