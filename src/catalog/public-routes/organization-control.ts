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

export const ORGANIZATION_CONTROL_PUBLIC_ROUTES = {
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
  'organizations.identityConfig.set': {
    openApi: {
      summary: 'Set an organization identity configuration',
      description:
        'Creates or replaces the public Signed User Assertion identity configuration for an active owner of an active Organization. Submit exactly one JWKS source. URL sources are fetched through the SSRF-protected JWKS path before saving. Existing status is preserved. A retryable cache error may mean the durable save succeeded; retrying the same request safely retries cache purge. The write is conditional only when `If-Match` or `If-None-Match` is sent; without either, the last write wins. A stale precondition answers `412 PRECONDITION_FAILED` and changes nothing.',
      parameters: [
        {
          name: 'organization_id',
          in: 'path',
          required: true,
          description: 'The organization whose identity configuration is set.',
          schema: { $ref: '#/components/schemas/OrganizationId' },
        },
        {
          name: 'If-Match',
          in: 'header',
          required: false,
          description:
            'The `ETag` of the configuration this write replaces, as one quoted value such as `"7"`. A different current revision refuses the write with `412`. Cannot be sent with `If-None-Match`.',
          schema: { type: 'string', pattern: '^"[1-9][0-9]*"$' },
        },
        {
          name: 'If-None-Match',
          in: 'header',
          required: false,
          description:
            'Send `*` to create the configuration only when none exists; an existing one refuses the write with `412`. Cannot be sent with `If-Match`.',
          schema: { type: 'string', enum: ['*'] },
        },
      ],
      successDescription:
        'The stored public identity configuration, including its preserved status.',
      etagHeaderDescription:
        'Strong entity tag of the configuration after this write, such as `"8"`; opaque.',
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
    errorStatuses: [400, 401, 403, 409, 412, 500, 503],
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
      etagHeaderDescription:
        'Strong entity tag of the stored configuration, such as `"7"`; opaque. Send it back in `If-Match` on the `PUT` to refuse the write if the configuration has changed since. Absent when `configured` is false.',
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
} as const;
