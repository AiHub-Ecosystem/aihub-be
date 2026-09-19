import { type Static, Type } from '@sinclair/typebox';

export const RegisterRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 320 }),
    username: Type.String({ minLength: 1, maxLength: 64 }),
    password: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export type RegisterRequest = Static<typeof RegisterRequestSchema>;

export const VerifyEmailRequestSchema = Type.Object(
  { token: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);

export type VerifyEmailRequest = Static<typeof VerifyEmailRequestSchema>;

export const ResendVerificationRequestSchema = Type.Object(
  { email: Type.String({ minLength: 1, maxLength: 320 }) },
  { additionalProperties: false },
);

export type ResendVerificationRequest = Static<
  typeof ResendVerificationRequestSchema
>;

export const RegisterResponseSchema = Type.Object(
  {
    data: Type.Object({
      email: Type.String(),
      username: Type.String(),
      status: Type.Literal('pending_verification'),
    }),
    meta: Type.Object({ request_id: Type.String() }),
  },
  { additionalProperties: false },
);
