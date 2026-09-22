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

export const CreateOrganizationResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        organization: Type.Object(
          {
            organization_id: Type.String({ minLength: 1 }),
            name: Type.String({ minLength: 1, maxLength: 100 }),
            status: Type.Literal('active'),
          },
          { additionalProperties: false },
        ),
        role: Type.Literal('owner'),
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

export type CreateOrganizationResponse = Static<
  typeof CreateOrganizationResponseSchema
>;
