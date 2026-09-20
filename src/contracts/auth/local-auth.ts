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

export const ForgotPasswordRequestSchema = Type.Object(
  { email: Type.String({ minLength: 1, maxLength: 320 }) },
  { additionalProperties: false },
);

export type ForgotPasswordRequest = Static<typeof ForgotPasswordRequestSchema>;

export const ResetPasswordRequestSchema = Type.Object(
  {
    token: Type.String({ minLength: 1, maxLength: 512 }),
    password: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export type ResetPasswordRequest = Static<typeof ResetPasswordRequestSchema>;

export const LoginRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 256 }),
  },
  { additionalProperties: false },
);

export type LoginRequest = Static<typeof LoginRequestSchema>;

export const LoginResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        access_token: Type.String({ minLength: 1 }),
        token_type: Type.Literal('Bearer'),
        expires_in: Type.Literal(900),
      },
      { additionalProperties: false },
    ),
    meta: Type.Object(
      { request_id: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const EmptyAuthRequestSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type EmptyAuthRequest = Static<typeof EmptyAuthRequestSchema>;

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

export const ForgotPasswordResponseSchema = Type.Object(
  {
    data: Type.Object(
      { message: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    meta: Type.Object(
      { request_id: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
