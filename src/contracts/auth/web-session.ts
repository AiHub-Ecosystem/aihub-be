import { type Static, Type } from '@sinclair/typebox';

import { PasswordSchema } from '@/contracts/auth/local-auth';

/**
 * The Customer Web BFF signs a user in server-to-server: an email, a password,
 * and its own client secret in `X-AIHUB-Client-Secret`. The secret is never in
 * this body, and the Web Session token comes back in the response body, never
 * in a cookie.
 */
export const CreateWebSessionRequestSchema = Type.Object(
  {
    email: Type.String({ minLength: 1, maxLength: 320 }),
    password: PasswordSchema,
  },
  { additionalProperties: false },
);

export type CreateWebSessionRequest = Static<
  typeof CreateWebSessionRequestSchema
>;

/**
 * The opaque token and the instant it stops being accepted. The token is
 * non-rotating: the BFF stores it in its own HttpOnly cookie and sends it back
 * on every exchange, so nothing here changes until the session is revoked or
 * expires.
 */
export const CreateWebSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        web_session_token: Type.String({
          pattern: '^[A-Za-z0-9_-]{43}$',
          description:
            'Opaque 32-byte credential, base64url. AIHUB stores only its SHA-256 hash.',
        }),
        expires_at: Type.String({
          format: 'date-time',
          description:
            'ISO 8601 instant the session expires. Sliding: a successful exchange moves it 30 days forward.',
        }),
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

export type CreateWebSessionResponse = Static<
  typeof CreateWebSessionResponseSchema
>;
