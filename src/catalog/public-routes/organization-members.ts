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
  DEFAULT_COLLECTION_PAGE_SIZE,
  DEFAULT_ROSTER_PAGE_SIZE,
  MAX_COLLECTION_PAGE_SIZE,
  MAX_ROSTER_PAGE_SIZE,
  ROSTER_MEMBERS_PER_ORGANIZATION,
} from '@/contracts/organization/pagination';

export const ORGANIZATION_MEMBERS_PUBLIC_ROUTES = {
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
        'Returns the Organizations where the authenticated user has an active membership, including suspended Organizations, ordered by `organization_id` ascending and paginated by limit and an opaque cursor. A page holds whole Organizations and never splits one. Each Organization lists its first ' +
        String(ROSTER_MEMBERS_PER_ORGANIZATION) +
        ' active members by username; `member_count` is the number of active members, so a value larger than the length of `members` means the list is cut. The members of a larger Organization are paginated by the Organization members route, which needs an owner or admin role. `identity_configured` reports only whether an active identity configuration is saved; the JWKS source is not probed and its URL or key material is not returned. A traversal is a live read, not a snapshot: membership is checked again on every page, so an Organization the caller left can disappear and one the caller joined behind the cursor appears only after a restart.',
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          description:
            'Organizations per page. A value outside the range is rejected rather than clamped, because a silently shortened page is indistinguishable from the end of the collection.',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ROSTER_PAGE_SIZE,
            default: DEFAULT_ROSTER_PAGE_SIZE,
          },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opaque position from a previous `next_cursor`. Bound to the authenticated user: replaying it as another user is rejected.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
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
    errorStatuses: [400, 401, 403, 500],
  },
  'organizations.members.list': {
    openApi: {
      summary: "List an organization's memberships",
      description:
        'Active owners and admins may list active or disabled memberships for one active Organization, paginated by limit and an opaque cursor. The filter defaults to active membership and does not depend on the member account status. Results are ordered by immutable username ascending and omit account IDs and email addresses. A traversal is a live read, not a snapshot: rows added before the cursor appear after a restart, and rows that are removed or change status can disappear.',
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
        {
          name: 'limit',
          in: 'query',
          required: false,
          description:
            'Members per page. A value outside the range is rejected rather than clamped, because a silently shortened page is indistinguishable from the end of the collection.',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_COLLECTION_PAGE_SIZE,
            default: DEFAULT_COLLECTION_PAGE_SIZE,
          },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opaque position from a previous `next_cursor`. Bound to the organization and status filter it was issued under: replaying it under a different scope is rejected.',
          schema: { type: 'string', minLength: 1 },
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
  'organizations.invitations.list': {
    openApi: {
      summary: "List an organization's open invitations",
      description:
        'Active owners and admins may list open, unexpired invitations for one active Organization, paginated by limit and an opaque cursor. Results are ordered by creation timestamp descending, tie-broken by invitation ID ascending. A traversal is a live read, not a snapshot: rows added before the cursor appear after a restart, and rows that are accepted, revoked, superseded, or expired can disappear.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose open invitations are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description:
            'Invitations per page. A value outside the range is rejected rather than clamped, because a silently shortened page is indistinguishable from the end of the collection.',
          schema: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_COLLECTION_PAGE_SIZE,
            default: DEFAULT_COLLECTION_PAGE_SIZE,
          },
        },
        {
          name: 'cursor',
          in: 'query',
          required: false,
          description:
            'Opaque position from a previous `next_cursor`. Bound to the organization it was issued under: replaying it under a different organization is rejected.',
          schema: { type: 'string', minLength: 1 },
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
    errorStatuses: [400, 401, 403, 500],
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
} as const;
