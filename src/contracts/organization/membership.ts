import { type Static, Type } from '@sinclair/typebox';

const OrganizationMembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
]);

const OrganizationStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('suspended'),
]);

const OrganizationRosterMemberSchema = Type.Object(
  {
    username: Type.String({ minLength: 1 }),
    role: OrganizationMembershipRoleSchema,
  },
  { additionalProperties: false },
);

const OrganizationRosterOrganizationSchema = Type.Object(
  {
    organization_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    status: OrganizationStatusSchema,
    membership: Type.Object(
      { role: OrganizationMembershipRoleSchema },
      { additionalProperties: false },
    ),
    members: Type.Array(OrganizationRosterMemberSchema),
  },
  { additionalProperties: false },
);

export const OrganizationRosterResponseSchema = Type.Object(
  {
    data: Type.Object(
      { organizations: Type.Array(OrganizationRosterOrganizationSchema) },
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

export type OrganizationRosterResponse = Static<
  typeof OrganizationRosterResponseSchema
>;
