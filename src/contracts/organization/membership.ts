import {
  NextCursorSchema,
  ResponseMetaSchema,
} from '@/contracts/response-meta';
import { type Static, Type } from '@sinclair/typebox';

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

export const OrganizationMembershipListQuerySchema = Type.Object(
  {
    status: Type.Optional(OrganizationMembershipStatusSchema),
    limit: Type.Optional(Type.String()),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type OrganizationMembershipListQuery = Static<
  typeof OrganizationMembershipListQuerySchema
>;

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

export const OrganizationRosterQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.String()),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type OrganizationRosterQuery = Static<
  typeof OrganizationRosterQuerySchema
>;

const OrganizationRosterOrganizationSchema = Type.Object(
  {
    organization_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    status: OrganizationStatusSchema,
    identity_configured: Type.Boolean(),
    entitlements: Type.Array(Type.String({ minLength: 1 })),
    membership: Type.Object(
      { role: OrganizationMembershipRoleSchema },
      { additionalProperties: false },
    ),
    member_count: Type.Integer({ minimum: 0 }),
    members: Type.Array(OrganizationRosterMemberSchema),
  },
  { additionalProperties: false },
);

export const OrganizationRosterResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        organizations: Type.Array(OrganizationRosterOrganizationSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type OrganizationRosterResponse = Static<
  typeof OrganizationRosterResponseSchema
>;

const OrganizationMembershipListMemberSchema = Type.Object(
  {
    username: Type.String({ minLength: 1 }),
    role: OrganizationMembershipRoleSchema,
    status: OrganizationMembershipStatusSchema,
  },
  { additionalProperties: false },
);

export const OrganizationMembershipListResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        members: Type.Array(OrganizationMembershipListMemberSchema),
        next_cursor: NextCursorSchema,
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type OrganizationMembershipListResponse = Static<
  typeof OrganizationMembershipListResponseSchema
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
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type OrganizationMembershipMutationResponse = Static<
  typeof OrganizationMembershipMutationResponseSchema
>;
