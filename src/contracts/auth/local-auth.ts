import { FormatRegistry, type Static, Type } from '@sinclair/typebox';

import {
  PASSWORD_MAX_CODE_POINTS,
  PASSWORD_MIN_CODE_POINTS,
  isValidPassword,
} from '../../modules/auth/domain/local-auth';

const PASSWORD_POLICY_FORMAT = 'aihub-password-policy';
export const PASSWORD_POLICY_DESCRIPTION = `${PASSWORD_MIN_CODE_POINTS}–${PASSWORD_MAX_CODE_POINTS} Unicode code points; no normalization.`;

if (!FormatRegistry.Has(PASSWORD_POLICY_FORMAT)) {
  FormatRegistry.Set(PASSWORD_POLICY_FORMAT, isValidPassword);
}

const PASSWORD_RUNTIME_MAX_CODE_UNITS = PASSWORD_MAX_CODE_POINTS * 2;

const PasswordSchema = Type.String({
  minLength: 1,
  maxLength: PASSWORD_RUNTIME_MAX_CODE_UNITS,
  format: PASSWORD_POLICY_FORMAT,
  description: PASSWORD_POLICY_DESCRIPTION,
});

export const RegisterRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 320 }),
    username: Type.String({ minLength: 1, maxLength: 64 }),
    password: PasswordSchema,
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
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export type ResetPasswordRequest = Static<typeof ResetPasswordRequestSchema>;

export const LoginRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 320 }),
    password: PasswordSchema,
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
