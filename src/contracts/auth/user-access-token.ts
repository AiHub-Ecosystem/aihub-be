import { type Static, Type } from '@sinclair/typebox';

export const RevokeUserAccessTokenRequestSchema = Type.Object(
  {
    token: Type.String({
      minLength: 1,
      maxLength: 8192,
      description: 'The compact User Access JWT to revoke.',
    }),
  },
  { additionalProperties: false },
);

export type RevokeUserAccessTokenRequest = Static<
  typeof RevokeUserAccessTokenRequestSchema
>;
