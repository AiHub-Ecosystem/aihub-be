import { type Static, Type } from '@sinclair/typebox';

export const ORGANIZATION_ROSTER_PATH = '/v1/organizations/me/members';

const OrganizationMembershipRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('admin'),
  Type.Literal('member'),
]);

const OrganizationMembershipMutationRoleSchema = Type.Union([
  Type.Literal('admin'),
  Type.Literal('member'),
]);

const OrganizationMembershipStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('disabled'),
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
    entitlements: Type.Array(Type.String({ minLength: 1 })),
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

export const OrganizationMembershipMutationRequestSchema = Type.Object(
  {
    role: OrganizationMembershipMutationRoleSchema,
  },
  { additionalProperties: false },
);

export type OrganizationMembershipMutationRequest = Static<
  typeof OrganizationMembershipMutationRequestSchema
>;

export const EmptyOrganizationMembershipMutationRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

const OrganizationMembershipMutationDataSchema = Type.Object(
  {
    organization_id: Type.String({ minLength: 1 }),
    username: Type.String({ minLength: 1 }),
    role: OrganizationMembershipRoleSchema,
    status: OrganizationMembershipStatusSchema,
  },
  { additionalProperties: false },
);

export const OrganizationMembershipMutationResponseSchema = Type.Object(
  {
    data: OrganizationMembershipMutationDataSchema,
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

export type OrganizationMembershipMutationResponse = Static<
  typeof OrganizationMembershipMutationResponseSchema
>;
