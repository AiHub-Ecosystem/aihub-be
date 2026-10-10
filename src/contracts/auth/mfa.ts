import { type Static, Type } from '@sinclair/typebox';

import { PasswordSchema } from './local-auth';

export const BeginMfaEnrollmentRequestSchema = Type.Object(
  { password: PasswordSchema },
  { additionalProperties: false },
);
export const ConfirmMfaEnrollmentRequestSchema = Type.Object(
  { code: Type.String({ pattern: '^\\d{6}$' }) },
  { additionalProperties: false },
);
export const RemoveMfaFactorRequestSchema = Type.Union([
  Type.Object({ password: PasswordSchema }, { additionalProperties: false }),
  Type.Object(
    { code: Type.String({ pattern: '^\\d{6}$' }) },
    { additionalProperties: false },
  ),
]);
export const BeginMfaEnrollmentResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        secret: Type.String({ minLength: 32, maxLength: 32 }),
        otpauth_uri: Type.String({ minLength: 1, maxLength: 512 }),
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
export type BeginMfaEnrollmentResponse = Static<
  typeof BeginMfaEnrollmentResponseSchema
>;

export const ConfirmMfaEnrollmentResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        recovery_codes: Type.Array(
          Type.String({ pattern: '^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$' }),
          { minItems: 8, maxItems: 8 },
        ),
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
export type ConfirmMfaEnrollmentResponse = Static<
  typeof ConfirmMfaEnrollmentResponseSchema
>;
