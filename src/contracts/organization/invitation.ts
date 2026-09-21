import { type Static, Type } from '@sinclair/typebox';

const OrganizationMembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
]);

export const CreateOrganizationInvitationRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 3, maxLength: 320 }),
    role: OrganizationMembershipRoleSchema,
  },
  { additionalProperties: false },
);

export type CreateOrganizationInvitationRequest = Static<
  typeof CreateOrganizationInvitationRequestSchema
>;

/**
 * The raw Organization Invite Token is deliberately absent: it belongs to the
 * invited person, not to the inviting caller, and only its hash is durable.
 */
export const CreateOrganizationInvitationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        invitation_id: Type.String({
          pattern: '^oiv_[0-9A-HJKMNP-TV-Z]{26}$',
        }),
        organization_id: Type.String({ minLength: 1 }),
        email: Type.String({ minLength: 3, maxLength: 320 }),
        role: OrganizationMembershipRoleSchema,
        status: Type.Literal('pending'),
        expires_at: Type.String({ format: 'date-time' }),
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

export type CreateOrganizationInvitationResponse = Static<
  typeof CreateOrganizationInvitationResponseSchema
>;

export const AcceptOrganizationInvitationRequestSchema = Type.Object(
  {
    token: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type AcceptOrganizationInvitationRequest = Static<
  typeof AcceptOrganizationInvitationRequestSchema
>;

/**
 * The organization comes from the redeemed invitation, never from the request,
 * so the response is where the caller first learns which tenant they joined.
 */
export const AcceptOrganizationInvitationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        organization_id: Type.String({ minLength: 1 }),
        role: OrganizationMembershipRoleSchema,
        status: Type.Literal('active'),
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

export type AcceptOrganizationInvitationResponse = Static<
  typeof AcceptOrganizationInvitationResponseSchema
>;
