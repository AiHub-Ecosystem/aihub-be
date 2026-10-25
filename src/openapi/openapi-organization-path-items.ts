import { PUBLIC_ROUTES } from '@/catalog/public-routes';
import {
  idempotencyKeyParameter,
  routeErrorResponsesOf,
  routeIdempotencyExtensionsOf,
  routeIdentityScopeOf,
  routeReplayHeaderOf,
  routeSchemaOf,
  routeSuccessKeyOf,
} from './openapi-shared';

export function organizationInvitationAcceptPathItem(): Record<
  string,
  unknown
> {
  const id = 'organizations.invitations.accept' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Accept an organization invitation',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/CorrelationId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'Organization membership granted or reactivated',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function organizationPathItem(): Record<string, unknown> {
  const id = 'organizations.create' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Create a Self-serve Organization and become its first owner',
      description:
        'Commercial terms are operator-controlled defaults and cannot be set by the request. Each account may create a limited number of Organizations over its lifetime.',
      ...routeIdentityScopeOf(id),
      ...routeIdempotencyExtensionsOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        idempotencyKeyParameter(PUBLIC_ROUTES[id].idempotency),
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Organization created with the caller as its active owner',
          ...routeReplayHeaderOf(
            id,
            'Present with value true when the completed creation result was replayed for this key.',
          ),
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

/**
 * Owner-only and name-only (ADR-0043). No Idempotency-Key: a repeat of the
 * applied name succeeds and changes nothing.
 */
export function organizationItemPathItem(): Record<string, unknown> {
  const id = 'organizations.rename' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Rename an organization',
      description:
        'Only an active owner of an active organization may rename it. Every other caller, and a suspended organization, receives the same denial. Commercial terms and status cannot be changed by this request.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization to rename.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(id, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'The organization under its current name',
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

/**
 * Described by hand for the same reason as the roster: it is a management
 * route, not a catalogued proxy operation.
 */
export function organizationInvitationPathItem(): Record<string, unknown> {
  const list = 'organizations.invitations.list' as const;
  const create = 'organizations.invitations.create' as const;

  return {
    get: {
      operationId: list,
      summary: "List an organization's open invitations",
      ...routeIdentityScopeOf(list),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose open invitations are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(list)]: {
          description: 'Open organization invitations',
          content: {
            'application/json': {
              schema: routeSchemaOf(list, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(list),
      },
    },
    post: {
      operationId: create,
      summary: 'Invite a person to an organization',
      ...routeIdentityScopeOf(create),
      ...routeIdempotencyExtensionsOf(create),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        idempotencyKeyParameter(PUBLIC_ROUTES[create].idempotency),
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization the invited person is invited to.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(create, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(create)]: {
          description:
            'Pending organization invitation created; the single-use invite credential reaches the invited person by email only',
          ...routeReplayHeaderOf(
            create,
            'Present with value true when the completed invitation result was replayed for this key.',
          ),
          content: {
            'application/json': {
              schema: routeSchemaOf(create, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(create),
      },
    },
  };
}

export function organizationInvitationItemPathItem(): Record<string, unknown> {
  const id = 'organizations.invitations.revoke' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Revoke an organization invitation',
      description:
        'Closes an open invitation using the durable invitation close signal. An already closed or expired invitation is a retry-safe no-op and still returns bodyless 204.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
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
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'Invitation closed, or already closed/expired; the response has no body',
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function organizationApiKeyItemPathItem(): Record<string, unknown> {
  const id = 'organizations.apiKeys.revoke' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Revoke an organization API key',
      description:
        'Withdraws the key and keeps its durable row, purging the identity cache so the change takes effect inside the existing cache ceiling. State-idempotent: withdrawing an already withdrawn key succeeds and leaves the recorded moment unchanged. This is the only response from which `revoked` is reachable.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
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
      responses: {
        [routeSuccessKeyOf(id)]: {
          description: 'API key withdrawn; its durable row is kept',
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

export function organizationApiKeyRotatePathItem(): Record<string, unknown> {
  const id = 'organizations.apiKeys.rotate' as const;

  return {
    [PUBLIC_ROUTES[id].method.toLowerCase()]: {
      operationId: id,
      summary: 'Rotate an organization API key',
      description:
        'Creates a replacement and revokes the named key in one act, with no window in which both work. The replacement inherits the name, scopes, and expiry. It keeps the first stored allowed environment only; a legacy key that allows multiple environments is narrowed to that one environment. Legacy environments without a dedicated key prefix keep the compatibility prefix. The raw credential is returned in this response only. A revoked or expired key cannot be rotated.',
      ...routeIdentityScopeOf(id),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
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
      responses: {
        [routeSuccessKeyOf(id)]: {
          description:
            'API key rotated; the raw replacement is returned in this response only and cannot be recovered afterwards. `status` is always `active`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': { schema: routeSchemaOf(id, 'response') },
          },
        },
        ...routeErrorResponsesOf(id),
      },
    },
  };
}

export function organizationApiKeyPathItem(): Record<string, unknown> {
  const list = 'organizations.apiKeys.list' as const;
  const create = 'organizations.apiKeys.create' as const;

  return {
    get: {
      operationId: list,
      summary: 'List an organization API key inventory',
      description:
        'Returns the organization live API keys as metadata only. Revoked keys are absent; `status` is `expired` once a key expiry has passed. `last_used_at` is approximate.',
      ...routeIdentityScopeOf(list),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose API keys are listed.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      responses: {
        [routeSuccessKeyOf(list)]: {
          description:
            'Live API key inventory; never a credential hash or raw credential',
          content: {
            'application/json': {
              schema: routeSchemaOf(list, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(list),
      },
    },
    post: {
      operationId: create,
      summary: 'Create an organization API key',
      ...routeIdentityScopeOf(create),
      security: [{ BearerAuth: [] }],
      parameters: [
        { $ref: '#/components/parameters/CorrelationId' },
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization that will own the API key.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: routeSchemaOf(create, 'request') },
        },
      },
      responses: {
        [routeSuccessKeyOf(create)]: {
          description:
            'API key created; the raw credential is returned in this response only and cannot be recovered afterwards. `status` is always `active`: a requested expiry must be in the future, so this response never carries `expired`.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', enum: ['no-store'] },
            },
          },
          content: {
            'application/json': {
              schema: routeSchemaOf(create, 'response'),
            },
          },
        },
        ...routeErrorResponsesOf(create),
      },
    },
  };
}
