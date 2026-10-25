import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import {
  DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE,
  MAX_ORGANIZATION_AUDIT_PAGE_SIZE,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
} from '@/contracts/organization/audit-event';
import {
  routeErrorResponsesOf,
  routeIdentityScopeOf,
  routeSchemaOf,
  routeSuccessKeyOf,
} from './openapi-shared';

/**
 * The first path in this document to carry query parameters. `action` is
 * declared `explode: true` on purpose: the server reads a repeated key, so a
 * generated client that comma-joined its values would send something no
 * parameter here accepts.
 */
export function organizationAuditEventPathItem(): Record<string, unknown> {
  const id = 'organizations.auditEvents.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Read an organization audit trail',
      description:
        'Returns the organization recorded control-plane acts, newest first, paginated by an opaque cursor. Active owners and admins may read; members, non-members, and disabled memberships receive one indistinguishable denial. A suspended organization stays readable, because the trail is evidence rather than a management surface. The actor is named by immutable username: no user account id, target id, key hash, or token hash appears. An event whose label has been removed by audit redaction is returned with `target_label` null rather than hidden.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose audit trail is read.',
          schema: { type: 'string', minLength: 1 },
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
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'One page of recorded acts, newest first. `next_cursor` is null at the end of the trail.',
          content: {
            'application/json': {
              schema: routeSchemaOf(id, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function organizationIdentityConfigPathItem(): Record<string, unknown> {
  const read = 'organizations.identityConfig.read' as const;
  const set = 'organizations.identityConfig.set' as const;

  return {
    put: {
      operationId: set,
      summary: 'Set an organization identity configuration',
      description:
        'Creates or replaces the public Signed User Assertion identity configuration for an active owner of an active Organization. Submit exactly one JWKS source. URL sources are fetched through the SSRF-protected JWKS path before saving. Existing status is preserved. A retryable cache error may mean the durable save succeeded; retrying the same request safely retries cache purge.',
      ...routeIdentityScopeOf(set),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is set.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(set, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(set)]: {
          description:
            'The stored public identity configuration, including its preserved status.',
          content: {
            'application/json': { schema: routeSchemaOf(set, 'response') },
          },
        },
        ...routeErrorResponsesOf(set),
      },
    },
    get: {
      operationId: read,
      summary: 'Read an organization identity configuration',
      description:
        'Returns the stored public Signed User Assertion identity configuration to an active owner of an active Organization. Admins, members, disabled memberships, non-members, and owners of suspended Organizations receive the same Safe Authorization Denial. `configured` indicates whether a row exists, including disabled rows; `status` indicates whether that configuration is active. Private JWK members are never returned.',
      ...routeIdentityScopeOf(read),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is read.',
          schema: { type: 'string', minLength: 1 },
        },
      ],
      responses: {
        [routeSuccessKeyOf(read)]: {
          description:
            'Stored public identity configuration, or `configured: false` when no row exists.',
          content: {
            'application/json': {
              schema: routeSchemaOf(read, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(read),
      },
    },
  };
}

export function organizationRosterPathItem(): Record<string, unknown> {
  const id = 'organizations.me.members.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'List the authenticated user organization roster',
      description:
        'Returns the Organizations where the authenticated user has an active membership, including suspended Organizations. `identity_configured` reports only whether an active identity configuration is saved; the JWKS source is not probed and its URL or key material is not returned.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization roster',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function organizationMembershipListPathItem(): Record<string, unknown> {
  const id = 'organizations.members.list' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: "List an organization's memberships",
      description:
        'Active owners and admins may list active or disabled memberships for one active Organization. The filter defaults to active membership and does not depend on the member account status. Results are ordered by immutable username and omit account IDs and email addresses.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose memberships are listed.',
          schema: { type: 'string', minLength: 1 },
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
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization memberships',
          content: {
            'application/json': {
              schema: routeSchemaOf(id, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

function organizationMemberParameters(): readonly Record<string, unknown>[] {
  return [
    { $ref: '#/components/parameters/CorrelationId' },
    {
      name: 'organization_id',
      in: 'path',
      required: true,
      description: 'The organization whose membership is being changed.',
      schema: { type: 'string', minLength: 1 },
    },
    {
      name: 'username',
      in: 'path',
      required: true,
      description: 'The immutable public username of the target member.',
      schema: { type: 'string', minLength: 1 },
    },
  ];
}

export function organizationMembershipMutationPathItem(): Record<
  string,
  unknown
> {
  const changeRole = 'organizations.members.change_role' as const;
  const disable = 'organizations.members.disable' as const;

  const successFor = (id: typeof changeRole | typeof disable) => ({
    [routeSuccessKeyOf(id)]: {
      description: 'The resulting organization membership',
      content: {
        'application/json': { schema: routeSchemaOf(id, 'response') },
      },
    },
  });

  return {
    patch: {
      operationId: changeRole,
      summary: 'Change an organization member role',
      ...routeIdentityScopeOf(changeRole),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: routeSchemaOf(changeRole, 'request'),
          },
        },
      },
      responses: {
        ...successFor(changeRole),
        ...routeErrorResponsesOf(changeRole),
      },
    },
    delete: {
      operationId: disable,
      summary: 'Disable an organization member',
      ...routeIdentityScopeOf(disable),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        ...successFor(disable),
        ...routeErrorResponsesOf(disable),
      },
    },
  };
}

export function organizationMembershipTransferPathItem(): Record<
  string,
  unknown
> {
  const id = 'organizations.members.transfer' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Transfer organization ownership',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: organizationMemberParameters(),
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'The resulting organization membership',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}
