import { type Static, Type } from '@sinclair/typebox';

import {
  SANDBOX_USER_ID_MAX_LENGTH,
  SANDBOX_USER_ID_PATTERN,
} from '../../modules/identity/domain/sandbox-user-id';

/**
 * The end-user identifier is the only value the caller controls. Its bounds
 * come from the domain rather than being restated here, so the schema and the
 * application service that re-checks it cannot drift apart.
 */
export const SandboxUserIdSchema = Type.String({
  minLength: 1,
  maxLength: SANDBOX_USER_ID_MAX_LENGTH,
  pattern: SANDBOX_USER_ID_PATTERN,
});

/**
 * Unknown properties are rejected rather than ignored. This is a
 * credential-minting boundary: a caller who sends `exp` or `iss` believes they
 * are setting them, and silently dropping the field would leave them holding a
 * token whose lifetime is not what they asked for.
 */
export const MintSandboxAssertionRequestSchema = Type.Object(
  {
    user_id: SandboxUserIdSchema,
  },
  { additionalProperties: false },
);

export type MintSandboxAssertionRequest = Static<
  typeof MintSandboxAssertionRequestSchema
>;

/**
 * `expires_at` is seconds since the epoch, matching the `exp` claim it is read
 * from, so a caller can decide whether a cached assertion is still usable
 * without decoding the token.
 */
export const MintSandboxAssertionResponseSchema = Type.Object(
  {
    assertion: Type.String(),
    user_id: SandboxUserIdSchema,
    expires_at: Type.Integer(),
  },
  { additionalProperties: false },
);

export type MintSandboxAssertionResponse = Static<
  typeof MintSandboxAssertionResponseSchema
>;
