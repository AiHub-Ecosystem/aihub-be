import { type Static, Type } from '@sinclair/typebox';

/**
 * A Self-serve Organization is requested by name alone. Commercial terms are
 * absent on purpose and extra properties are rejected, so a client that sends
 * one learns it was refused rather than believing it was applied (ADR-0041).
 */
export const CreateOrganizationRequestSchema = Type.Object(
  {
    // Bounded after trimming by the use case: 1–100 characters.
    name: Type.String({
      minLength: 1,
      description: 'Trimmed, then 1–100 characters; not unique.',
    }),
  },
  { additionalProperties: false },
);

export type CreateOrganizationRequest = Static<
  typeof CreateOrganizationRequestSchema
>;

const OrganizationSchema = Type.Object(
  {
    organization_id: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    status: Type.Literal('active'),
  },
  { additionalProperties: false },
);

const ResponseMetaSchema = Type.Object(
  {
    request_id: Type.String({
      pattern: '^req_[0-9A-HJKMNP-TV-Z]{26}$',
    }),
  },
  { additionalProperties: false },
);

export const CreateOrganizationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        organization: OrganizationSchema,
        role: Type.Literal('owner'),
      },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type CreateOrganizationResponse = Static<
  typeof CreateOrganizationResponseSchema
>;

/**
 * A rename carries the name alone. Entitlements, limits, quota, hard stop, and
 * status are an operator's to change, and a request naming one is refused
 * rather than silently ignored (ADR-0043).
 */
export const RenameOrganizationRequestSchema = Type.Object(
  {
    // Bounded after trimming by the use case: 1–100 characters.
    name: Type.String({
      minLength: 1,
      description: 'Trimmed, then 1–100 characters; not unique.',
    }),
  },
  { additionalProperties: false },
);

export type RenameOrganizationRequest = Static<
  typeof RenameOrganizationRequestSchema
>;

export const RenameOrganizationResponseSchema = Type.Object(
  {
    data: Type.Object(
      { organization: OrganizationSchema },
      { additionalProperties: false },
    ),
    meta: ResponseMetaSchema,
  },
  { additionalProperties: false },
);

export type RenameOrganizationResponse = Static<
  typeof RenameOrganizationResponseSchema
>;
