import { type Static, Type } from '@sinclair/typebox';

/**
 * Mirrors the action constraint the audit table enforces, so the published
 * contract and the schema name the same set. A new Audit action reaches this
 * list through the migration that adds it, never ahead of it.
 */
export const ORGANIZATION_AUDIT_ACTIONS = [
  'organization.created',
  'organization.renamed',
  'invitation.sent',
  'invitation.resent',
  'invitation.accepted',
  'invitation.revoked',
  'membership.role_changed',
  'membership.disabled',
  'membership.owner_transferred',
  'api_key.created',
  'api_key.rotated',
  'api_key.revoked',
] as const;

export const ORGANIZATION_AUDIT_OUTCOMES = ['applied', 'denied'] as const;

/**
 * The page bounds live here rather than beside the use case because three
 * places must agree on them: the parser that rejects a value outside the
 * range, the use case that asks the repository for one beyond the page, and
 * the published contract. Restating them in the OpenAPI document would let
 * the documentation drift from the validator without anything failing.
 */
export const DEFAULT_ORGANIZATION_AUDIT_PAGE_SIZE = 50;
export const MAX_ORGANIZATION_AUDIT_PAGE_SIZE = 200;

const OrganizationAuditActionSchema = Type.Union(
  ORGANIZATION_AUDIT_ACTIONS.map((action) => Type.Literal(action)),
);

const OrganizationAuditOutcomeSchema = Type.Union(
  ORGANIZATION_AUDIT_OUTCOMES.map((outcome) => Type.Literal(outcome)),
);

const OrganizationAuditTargetTypeSchema = Type.Union([
  Type.Literal('organization'),
  Type.Literal('membership'),
  Type.Literal('invitation'),
  Type.Literal('api_key'),
]);

/**
 * The durable `target_id` is deliberately absent. For a membership target it
 * is the target's User Account ID, so publishing the column would hand out the
 * identifier this read exists to withhold; `target_type` and `target_label`
 * already say what was acted on and which one.
 *
 * `organization_id` is absent too: it is in the path and identical for every
 * event in the page.
 */
export const OrganizationAuditEventSchema = Type.Object(
  {
    event_id: Type.String({ pattern: '^oae_[0-9A-HJKMNP-TV-Z]{26}$' }),
    action: OrganizationAuditActionSchema,
    outcome: OrganizationAuditOutcomeSchema,
    target_type: OrganizationAuditTargetTypeSchema,
    /** `null` once Audit redaction has removed the label; the event stands. */
    target_label: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    /**
     * Populated from the per-action whitelist the write path applies. It stays
     * open here rather than restating that whitelist: the closed draft union
     * is what keeps a credential out, and a second copy of the shape would
     * need editing for every new Audit action.
     */
    detail: Type.Record(Type.String(), Type.Unknown()),
    actor_username: Type.String({ minLength: 1 }),
    /** The request that produced the act, not the request reading it. */
    originating_request_id: Type.String({ minLength: 1 }),
    occurred_at: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);

export const ListOrganizationAuditEventsResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        events: Type.Array(OrganizationAuditEventSchema),
        /** `null` at the end of the trail. */
        next_cursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      },
      { additionalProperties: false },
    ),
    meta: Type.Object(
      {
        request_id: Type.String({
          pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ListOrganizationAuditEventsResponse = Static<
  typeof ListOrganizationAuditEventsResponseSchema
>;
